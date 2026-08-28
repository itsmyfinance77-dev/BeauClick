import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase } from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * V3.1 Phase E — the two auth items that "look trivial and are not"
 * (`V3.1_GAP_RECONCILIATION.md`), against real PostgreSQL.
 *
 * **QA-19.** The resend button had no way to know when it would be allowed to
 * fire, so a user who tapped it early got a 429 the UI had not anticipated.
 * The fix is not a client-side timer guessing at a server constant: the API
 * now states the cooldown on success, and states the REMAINING cooldown when
 * it refuses.
 *
 * **QA-20.** `GET /v1/auth/sessions` returned `current: false` on every row.
 * The reason it stayed open through v3.0.1 is that fixing it honestly needs a
 * session identifier in the access token — a change to the shape of every
 * token the platform issues — and the cheap alternatives (match on user agent,
 * match on the newest row) are wrong in exactly the situation the feature
 * exists for: several devices, one of which the user wants to keep.
 *
 * The suite boots with a REAL cooldown rather than the harness default of 0,
 * because a cooldown of zero cannot demonstrate a cooldown.
 */
describePg('V3.1 Phase E — OTP cooldown and session identity (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  const COOLDOWN_SECONDS = 60;

  async function login(phone: string, deviceLabel: string): Promise<{ accessToken: string; refreshToken: string }> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/request-otp')
      .send({ phone, purpose: 'login' })
      .expect(200);

    const code = ctx.otpObserver.lastCodeFor(phone);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-otp')
      .set('x-device-label', deviceLabel)
      .send({ phone, code, purpose: 'login' })
      .expect(200);

    return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
  }

  /** Clears the cooldown by ageing the OTP rows, so a case can log in again without waiting a minute. */
  async function clearCooldown(): Promise<void> {
    await dataSource.query(`UPDATE identity.otp_requests SET created_at = created_at - interval '1 hour'`);
  }

  beforeAll(async () => {
    ctx = await createPgTestApp({
      OTP_RESEND_COOLDOWN_SECONDS: String(COOLDOWN_SECONDS),
      OTP_EXPIRY_SECONDS: '300',
      // The real per-phone hourly limit, so the case that distinguishes it
      // from the cooldown has something to trip. The IP limit stays high: every
      // request in this suite comes from one address, and tripping THAT would
      // make every case fail for a reason none of them is about.
      OTP_MAX_PER_PHONE_PER_HOUR: '5',
      OTP_MAX_PER_IP_PER_HOUR: '10000',
    });
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  describe('QA-19 — the resend cooldown is stated, not guessed', () => {
    it('a successful request reports the cooldown and the expiry', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/request-otp')
        .send({ phone: '+989125020001', purpose: 'login' })
        .expect(200);

      expect(res.body.data.requested).toBe(true);
      // Two DIFFERENT numbers, and confusing them is the bug this prevents:
      // a UI counting the expiry down would enable resend while the cooldown
      // still had 240 seconds to run.
      expect(res.body.data.cooldownRemaining).toBe(COOLDOWN_SECONDS);
      expect(res.body.data.expiresInSeconds).toBe(300);
    });

    it('a resend inside the window is refused WITH the remaining seconds', async () => {
      const phone = '+989125020002';
      await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' }).expect(200);

      const refused = await request(app.getHttpServer())
        .post('/api/v1/auth/request-otp')
        .send({ phone, purpose: 'login' })
        .expect(429);

      expect(refused.body.error.code).toBe('RATE_LIMITED');
      const remaining = refused.body.error.details.retryAfterSeconds;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(COOLDOWN_SECONDS);
    });

    it('reports the same cooldown whether or not the phone has an account', async () => {
      // The anti-enumeration property, checked on the NEW field. QA-19 adds a
      // number to a response whose entire design is that it must not vary with
      // account existence, so the number has to be checked against that rule
      // rather than assumed safe.
      await dataSource.query(`INSERT INTO identity.users (id, phone, roles) VALUES (gen_random_uuid(), $1, '{customer}')`, [
        '+989125020003',
      ]);

      const known = await request(app.getHttpServer())
        .post('/api/v1/auth/request-otp')
        .send({ phone: '+989125020003', purpose: 'login' })
        .expect(200);
      const unknown = await request(app.getHttpServer())
        .post('/api/v1/auth/request-otp')
        .send({ phone: '+989125020004', purpose: 'login' })
        .expect(200);

      expect(known.body).toEqual(unknown.body);
    });

    it('an hourly-limit refusal states NO retry time, because it cannot honestly state one', async () => {
      const phone = '+989125020005';
      // Fill the per-phone hourly window with rows that are old enough not to
      // trip the cooldown, so the limit that fires is the hourly one.
      for (let i = 0; i < 5; i += 1) {
        await dataSource.query(
          `INSERT INTO identity.otp_requests (id, phone, purpose, code_hash, expires_at, attempts_remaining, request_ip, created_at)
           VALUES (gen_random_uuid(), $1, 'login', 'x', now() + interval '5 minutes', 5, '127.0.0.1', now() - interval '5 minutes')`,
          [phone],
        );
      }

      const refused = await request(app.getHttpServer())
        .post('/api/v1/auth/request-otp')
        .send({ phone, purpose: 'login' })
        .expect(429);

      // When the window resets depends on when each of five earlier requests
      // landed. A plausible number here would have a client count down to a
      // moment that still fails, which is worse than no number.
      expect(refused.body.error.code).toBe('RATE_LIMITED');
      expect(refused.body.error.details?.retryAfterSeconds ?? null).toBeNull();
    });
  });

  describe('QA-20 — `current` identifies the session actually asking', () => {
    it('marks exactly one session current, and it is the caller’s own', async () => {
      const phone = '+989125020010';
      const phoneSession = await login(phone, 'phone');
      await clearCooldown();
      const laptopSession = await login(phone, 'laptop');

      const fromLaptop = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${laptopSession.accessToken}`)
        .expect(200);

      const rows: Array<{ deviceLabel: string; current: boolean }> = fromLaptop.body.data;
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.current)).toHaveLength(1);
      expect(rows.find((r) => r.current)?.deviceLabel).toBe('laptop');

      // The same list, asked by the other device, marks the other row. This is
      // the assertion a "newest row wins" implementation fails.
      const fromPhone = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${phoneSession.accessToken}`)
        .expect(200);
      expect(fromPhone.body.data.find((r: { current: boolean }) => r.current).deviceLabel).toBe('phone');
    });

    it('a token minted without the claim reports `current: false` rather than guessing', async () => {
      const phone = '+989125020020';
      const session = await login(phone, 'phone');
      const user = await dataSource.query('SELECT id FROM identity.users WHERE phone = $1', [phone]);

      // A token issued before the `sid` claim existed. Such tokens stay valid
      // for their full 15 minutes across a deploy, so this is a real state and
      // not a hypothetical.
      const { JwtService } = await import('@nestjs/jwt');
      const legacyToken = app.get(JwtService).sign({ sub: user[0].id, roles: ['customer'], capabilities: [] });

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${legacyToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].current).toBe(false);
      expect(session.accessToken).toBeTruthy();
    });

    it('the claim identifies the session and does not carry the credential', async () => {
      const phone = '+989125020030';
      const session = await login(phone, 'phone');

      const [, payloadB64] = session.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

      // `sid` is the refresh ROW's id. The refresh token itself is stored only
      // as a SHA-256 hash and must appear nowhere in the access token.
      expect(claims.sid).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.accessToken).not.toContain(session.refreshToken);

      const row = await dataSource.query('SELECT token_hash FROM identity.refresh_tokens WHERE id = $1', [claims.sid]);
      expect(row).toHaveLength(1);
      expect(row[0].token_hash).not.toBe(session.refreshToken);
    });

    it('follows the session across a rotation instead of losing track of it', async () => {
      const phone = '+989125020040';
      const session = await login(phone, 'phone');

      const refreshed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
        .expect(200);

      // ONE row, still, and it is current. Without the chain-tip filter this
      // would be two rows -- one per rotation -- and a device list would grow
      // by one entry every fifteen minutes of ordinary use.
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].current).toBe(true);
    });

    it('reports when the DEVICE signed in, not when the current token was minted', async () => {
      const phone = '+989125020050';
      const session = await login(phone, 'phone');

      const before = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      const originalStart = before.body.data[0].createdAt;

      // Age the chain so a rotation-created row would be visibly newer.
      await dataSource.query(
        `UPDATE identity.refresh_tokens
            SET created_at = created_at - interval '3 days', session_started_at = session_started_at - interval '3 days'`,
      );

      const refreshed = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
        .expect(200);

      // The new row was created seconds ago; the SESSION started three days
      // ago, and that is what the device list has to say or nobody can
      // recognise the laptop they left at the office.
      expect(new Date(after.body.data[0].createdAt).getTime()).toBeLessThan(new Date(originalStart).getTime());
    });

    it('revoking the current session is still ownership-checked', async () => {
      const alice = await login('+989125020060', 'phone');
      await clearCooldown();
      const bob = await login('+989125020061', 'phone');

      const hers = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);

      // `sid` identifies WHICH of the caller's own sessions is speaking. It is
      // never authorization: another user's session id resolves exactly the
      // way a nonexistent one does.
      await request(app.getHttpServer())
        .delete(`/api/v1/auth/sessions/${hers.body.data[0].id}`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/auth/sessions/${hers.body.data[0].id}`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);
    });
  });
});
