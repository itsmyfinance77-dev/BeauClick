import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { TokenService } from '@beauclick/identity';

import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase } from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * REAL PostgreSQL: demo remediation F-9 -- intentional revocation is not theft.
 *
 * Before the fix every revocation wrote only `revoked_at`, so a token ENDED on
 * purpose (logout, "sign out that device", logout-all) was indistinguishable
 * from one ROTATED by a refresh. A device signed out from another device that
 * later came back (after the 10 s grace) was treated as a replay and ALL the
 * user's sessions were revoked -- including the device that did the signing
 * out (measured on the demo).
 *
 * Every case below ages revocations past the grace window, because inside it
 * nothing cascades by design and the cases would prove nothing.
 */
describePg('Refresh-token revocation reasons (demo F-9, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  const http = () => request(app.getHttpServer());

  async function login(phone: string, deviceLabel: string): Promise<{ accessToken: string; refreshToken: string }> {
    // Each login is a fresh OTP; age earlier ones so the cooldown never interferes.
    await dataSource.query(`UPDATE identity.otp_requests SET created_at = created_at - interval '1 hour'`);
    await http().post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' }).expect(200);
    const code = ctx.otpObserver.lastCodeFor(phone);
    const res = await http()
      .post('/api/v1/auth/verify-otp')
      .set('x-device-label', deviceLabel)
      .send({ phone, code, purpose: 'login' })
      .expect(200);
    return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
  }

  const refresh = (refreshToken: string) => http().post('/api/v1/auth/refresh').send({ refreshToken });

  /** Past `REPLAY_GRACE_MS`, so only the reason decides what a re-presentation means. */
  const ageRevocations = () =>
    dataSource.query(`UPDATE identity.refresh_tokens SET revoked_at = revoked_at - interval '1 hour' WHERE revoked_at IS NOT NULL`);

  const liveCount = async (phone: string) => {
    const [{ n }] = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM identity.refresh_tokens t JOIN identity.users u ON u.id = t.user_id
        WHERE u.phone = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [phone],
    );
    return n as number;
  };

  const reasons = async (phone: string) =>
    (
      await dataSource.query(
        `SELECT t.revocation_reason AS r, COUNT(*)::int AS n FROM identity.refresh_tokens t JOIN identity.users u ON u.id = t.user_id
          WHERE u.phone = $1 GROUP BY 1 ORDER BY 1 NULLS FIRST`,
        [phone],
      )
    ).map((x: { r: string | null; n: number }) => `${x.r ?? 'live'}:${x.n}`);

  beforeAll(async () => {
    ctx = await createPgTestApp({ OTP_RESEND_COOLDOWN_SECONDS: '0', OTP_MAX_PER_PHONE_PER_HOUR: '1000', OTP_MAX_PER_IP_PER_HOUR: '100000' });
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  describe('intentional ends are refused, never escalated', () => {
    it('THE F-9 CASE: device A signs device B out; B returns later -> B 401, A keeps working', async () => {
      const phone = '+989125090001';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');

      const sessions = await http().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${a.accessToken}`).expect(200);
      const bSession = (sessions.body.data as { id: string; deviceLabel: string }[]).find((s) => s.deviceLabel === 'B')!;
      await http().delete(`/api/v1/auth/sessions/${bSession.id}`).set('Authorization', `Bearer ${a.accessToken}`).expect(200);
      await ageRevocations();

      expect((await refresh(b.refreshToken)).status).toBe(401);
      const aAfter = await refresh(a.refreshToken);
      expect(aAfter.status).toBe(200);
      expect(await liveCount(phone)).toBe(1);
      expect(await reasons(phone)).toEqual(['live:1', 'rotated:1', 'session_revoked:1']);
    });

    it('logout, then the same cookie again -> 401, the other device survives', async () => {
      const phone = '+989125090002';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');
      await http().post('/api/v1/auth/logout').send({ refreshToken: b.refreshToken }).expect(200);
      await ageRevocations();

      expect((await refresh(b.refreshToken)).status).toBe(401);
      expect((await refresh(a.refreshToken)).status).toBe(200);
      expect(await reasons(phone)).toEqual(['live:1', 'logout:1', 'rotated:1']);
    });

    it('logout-all, then an old cookie -> 401 and nothing else; a NEW sign-in survives it', async () => {
      const phone = '+989125090003';
      const a = await login(phone, 'A');
      await login(phone, 'B');
      await http().post('/api/v1/auth/logout-all-devices').set('Authorization', `Bearer ${a.accessToken}`).expect((r) => {
        if (r.status >= 300) throw new Error(`logout-all ${r.status}`);
      });
      await ageRevocations();
      const c = await login(phone, 'C');

      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect((await refresh(c.refreshToken)).status).toBe(200);
      expect(await liveCount(phone)).toBe(1);
    });
  });

  describe('replay detection is unchanged (must still cascade)', () => {
    it('a ROTATED token presented after the grace revokes every session of the user', async () => {
      const phone = '+989125090004';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');
      const rotated = await refresh(a.refreshToken);
      expect(rotated.status).toBe(200);
      await ageRevocations();

      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(0);
      expect((await refresh(rotated.body.data.refreshToken)).status).toBe(401);
      expect((await refresh(b.refreshToken)).status).toBe(401);
      expect(await reasons(phone)).toEqual(['replay_response:2', 'rotated:1']);
    });

    it('a legacy revoked token (NULL reason, pre-migration) still cascades', async () => {
      const phone = '+989125090005';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');
      // What a row revoked before the column existed looks like.
      await dataSource.query(
        `UPDATE identity.refresh_tokens t SET revoked_at = now() - interval '1 hour', revocation_reason = NULL
           FROM identity.users u WHERE u.id = t.user_id AND u.phone = $1 AND t.device_label = 'A'`,
        [phone],
      );
      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect((await refresh(b.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(0);
    });

    it('crash window: claimed (rotated) but no successor pointer -> still cascades', async () => {
      const phone = '+989125090006';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');
      await refresh(a.refreshToken);
      // A crash between the claim and the successor write leaves exactly this row.
      await dataSource.query(
        `UPDATE identity.refresh_tokens SET replaced_by_token_id = NULL WHERE revocation_reason = 'rotated'`,
      );
      await ageRevocations();

      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect((await refresh(b.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(0);
    });

    it('a thief cannot relabel a rotated token by "logging it out" first', async () => {
      const phone = '+989125090007';
      const a = await login(phone, 'A');
      const legit = await refresh(a.refreshToken);
      expect(legit.status).toBe(200);
      const [before] = await dataSource.query(
        `SELECT id, revoked_at, revocation_reason FROM identity.refresh_tokens WHERE revocation_reason = 'rotated'`,
      );

      // The stolen (already rotated) token is used to call logout.
      await http().post('/api/v1/auth/logout').send({ refreshToken: a.refreshToken }).expect(200);
      const [after] = await dataSource.query(`SELECT id, revoked_at, revocation_reason FROM identity.refresh_tokens WHERE id = $1`, [before.id]);
      expect(after).toEqual(before);
      expect(after.revocation_reason).toBe('rotated');

      await ageRevocations();
      expect((await refresh(a.refreshToken)).status).toBe(401);
      // Still a replay: the legitimate chain is ended as a precaution, exactly as before.
      expect((await refresh(legit.body.data.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(0);
    });

    it('two concurrent refreshes of one token: one wins, the loser is only denied (grace unchanged)', async () => {
      const phone = '+989125090008';
      const a = await login(phone, 'A');
      const [r1, r2] = await Promise.all([refresh(a.refreshToken), refresh(a.refreshToken)]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 401]);
      const winner = r1.status === 200 ? r1 : r2;
      expect((await refresh(winner.body.data.refreshToken)).status).toBe(200);
      expect(await liveCount(phone)).toBe(1);
    });
  });

  describe('failure between claim and issuance (actual semantics, NOT crash-atomic)', () => {
    /*
     * `rotate()` is three separate writes: the claim UPDATE (now also writing
     * reason 'rotated'), the new pair's INSERT, and the successor pointer. They
     * are not one transaction, and the recorded reason does not change that.
     * What the reason DOES guarantee: a token whose rotation failed half-way is
     * classified 'rotated' -- it can never be mistaken for an intentional end.
     * The consequence of the failure is the same as before this fix: the
     * client's session is lost (a retry inside the grace is only refused; after
     * the grace it is treated as a replay and cascades). Recorded here so the
     * behaviour is stated, not implied.
     */
    it('issuance fails after the claim: the token is dead as "rotated" with no successor; retry in grace -> 401 only, after grace -> cascade', async () => {
      const phone = '+989125090010';
      const a = await login(phone, 'A');
      const b = await login(phone, 'B');
      const tokens = app.get(TokenService);
      const spy = jest.spyOn(tokens, 'issuePair').mockRejectedValueOnce(new Error('planted failure after the claim'));
      try {
        const failed = await refresh(a.refreshToken);
        expect(failed.status).toBeGreaterThanOrEqual(500);
      } finally {
        spy.mockRestore();
      }
      const rows = await dataSource.query(
        `SELECT revocation_reason, replaced_by_token_id FROM identity.refresh_tokens t JOIN identity.users u ON u.id = t.user_id
          WHERE u.phone = $1 AND t.device_label = 'A'`,
        [phone],
      );
      expect(rows).toEqual([{ revocation_reason: 'rotated', replaced_by_token_id: null }]);

      // Inside the grace: refused, nothing else (B untouched).
      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(1);

      // After the grace: indistinguishable from a replay of a rotated token -> cascade (unchanged, strict).
      await ageRevocations();
      expect((await refresh(a.refreshToken)).status).toBe(401);
      expect((await refresh(b.refreshToken)).status).toBe(401);
      expect(await liveCount(phone)).toBe(0);
    });
  });

  describe('schema', () => {
    it('refuses an unknown reason, and a reason on a live token', async () => {
      const phone = '+989125090009';
      await login(phone, 'A');
      await expect(
        dataSource.query(`UPDATE identity.refresh_tokens SET revoked_at = now(), revocation_reason = 'whatever'`),
      ).rejects.toThrow(/ck_refresh_tokens_revocation_reason/);
      await expect(
        dataSource.query(`UPDATE identity.refresh_tokens SET revocation_reason = 'logout' WHERE revoked_at IS NULL`),
      ).rejects.toThrow(/ck_refresh_tokens_reason_requires_revocation/);
    });
  });
});
