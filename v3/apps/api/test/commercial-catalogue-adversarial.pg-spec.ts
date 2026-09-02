import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AdminAuditService } from '@beauclick/audit';
import { PRIVILEGED_CAPABILITIES } from '@beauclick/auth';
import { CommercialCatalogueService } from '@beauclick/commercial-policy';

import { PgTestApp, SeededUser, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

const BASE = '/api/v1/admin/commercial';
const T0 = '2027-01-01T00:00:00.000Z';
const T1 = '2027-06-01T00:00:00.000Z';

/**
 * The catalogue's authorization, audit and adversarial surface — V3.3-A Story
 * #40 (`#40a`), ADR-041 §9 and §14.
 *
 * ## What this file owns that the lifecycle suite cannot
 *
 * `commercial-catalogue.pg-spec.ts` drives the SERVICE and proves the
 * catalogue's rules. Everything here goes through HTTP, because the properties
 * below are properties of the ROUTE:
 *
 *  * a capability check that runs before any handler;
 *  * a live revocation re-check that does not wait for a token to expire;
 *  * a global `ValidationPipe` that rejects a field no DTO declares;
 *  * an actor that comes from the session and cannot be supplied;
 *  * a response body that does not carry administrator identity.
 *
 * ## The audit log cannot be truncated, and that is deliberate
 *
 * `admin.admin_audit_log` is owned by a role the application never connects as,
 * and the application holds INSERT + SELECT only — so `resetDatabase` cannot
 * clear it and rows accumulate across a run. Every assertion here therefore
 * filters by `target_id`, exactly as `operability-foundation.pg-spec.ts` does,
 * and never counts the table. Granting the test role DELETE would mean the
 * suite proved immutability against a role that does not have it.
 */
describePg('commercial catalogue — authorization, audit and adversarial (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let audit: AdminAuditService;

  let admin: SeededUser;
  let customer: SeededUser;
  let operator: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;

  const asAdmin = (): request.Test => request(app.getHttpServer()).get(`${BASE}/plans`);

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
    audit = app.get(AdminAuditService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(dataSource);
    const stamp = String(800000 + (sequence % 90000)).slice(0, 6);
    admin = await seedUser(app, dataSource, `+98913${stamp}`, ['administrator']);
    customer = await seedUser(app, dataSource, `+98914${stamp}`, ['customer']);
    operator = await seedUser(app, dataSource, `+98915${stamp}`, ['platform_operator']);
  });

  async function auditRowsFor(targetId: string): Promise<Array<{ action: string; reason: string | null; actor_user_id: string | null }>> {
    return dataSource.query(
      `SELECT action, reason, actor_user_id FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    );
  }

  async function publishedSchedule(): Promise<{ key: string; id: string }> {
    const key = nextKey('adv-sched');
    await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'adversarial suite setup');
    const draft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey: key,
        displayName: 'adversarial',
        activationStartsAt: new Date(T0),
        activationEndsAt: null,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: 1,
          maxPurchaseQuantity: 100,
          uiPresetQuantities: [],
          tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 1_000 }],
        },
      },
      'adversarial suite setup',
    );
    const published = await catalogue.publishScheduleVersion(admin.id, key, draft.version, 'adversarial suite setup');
    return { key, id: published.id };
  }

  function planVersionBody(scheduleVersionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      reason: 'creating a draft for the adversarial suite',
      displayName: 'adversarial plan',
      billingTermDays: 30,
      includedBookingCredits: 0,
      staffSeats: 0,
      includedLocations: 0,
      capabilityKeys: [],
      priceScheduleVersionId: scheduleVersionId,
      autoAssignable: false,
      activationStartsAt: T0,
      activationEndsAt: null,
      ...extra,
    };
  }

  // =========================================================================
  // §A. Authorization
  // =========================================================================

  describe('§A authorization', () => {
    it('the capability is PRIVILEGED, which is what confers the re-check and the boot assertion', () => {
      expect(PRIVILEGED_CAPABILITIES).toContain('bc_manage_commercial_plans');
    });

    it('refuses an unauthenticated caller on every route', async () => {
      // Each request is BUILT inside the loop, not collected into an array
      // first: `request(server)` binds an ephemeral listener per call, and
      // building four up front leaves three pointing at a closed port —
      // ECONNREFUSED, which reads exactly like a product failure.
      const calls: Array<[string, string, Record<string, unknown> | null]> = [
        ['get', `${BASE}/plans`, null],
        ['post', `${BASE}/plans`, { planKey: 'Unauthenticated', reason: 'a mutation with no token at all' }],
        ['get', `${BASE}/price-schedules`, null],
        [
          'post',
          `${BASE}/price-schedules`,
          { scheduleKey: 'Unauthenticated', purpose: 'booking_credit', reason: 'a mutation with no token at all' },
        ],
      ];

      for (const [method, path, body] of calls) {
        const server = app.getHttpServer();
        const response = await (method === 'get'
          ? request(server).get(path)
          : request(server).post(path).send(body ?? {}));
        expect(response.status).toBe(401);
      }
    });

    it('refuses a CUSTOMER, who holds no commercial capability', async () => {
      const response = await request(app.getHttpServer())
        .get(`${BASE}/plans`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(response.status).toBe(403);
    });

    it('refuses a PLATFORM_OPERATOR: the narrower privileged tier is not commercial authority', async () => {
      // The deliberate scoping decision in ADR-041 §9, asserted rather than
      // left to the migration's comment.
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${operator.accessToken}`)
        .send({ planKey: nextKey('op'), reason: 'a platform operator trying to publish commercial terms' });
      expect(response.status).toBe(403);
    });

    it('admits an ADMINISTRATOR', async () => {
      const response = await asAdmin().set('Authorization', `Bearer ${admin.accessToken}`);
      expect(response.status).toBe(200);
    });

    /**
     * LIVE REVOCATION.
     *
     * The token is unchanged and still carries `bc_manage_commercial_plans` —
     * it was minted before the revocation and has minutes of validity left.
     * `CapabilityGuard` consults `PRIVILEGED_CAPABILITY_VERIFIER` against live
     * data for a privileged capability, so the withdrawal takes effect on the
     * NEXT REQUEST rather than at token expiry.
     */
    it('refuses on the next request after the role is revoked, with the SAME token', async () => {
      const before = await asAdmin().set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.status).toBe(200);

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [admin.id]);

      const after = await asAdmin().set('Authorization', `Bearer ${admin.accessToken}`);
      expect(after.status).toBe(403);
      expect(after.body?.error?.code ?? after.body?.code).toBe('FORBIDDEN');
    });

    it('a revoked administrator cannot MUTATE either, not merely read', async () => {
      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [admin.id]);
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey: nextKey('revoked'), reason: 'publishing after my authority was withdrawn' });
      expect(response.status).toBe(403);

      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM commercial.plans`);
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // §B. The mandatory reason
  // =========================================================================

  describe('§B mandatory reason', () => {
    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['too short', 'x'],
    ])('refuses a %s reason at validation, before anything is written', async (_label, reason) => {
      const planKey = nextKey('noreason');
      const body: Record<string, unknown> = { planKey };
      if (reason !== undefined) body.reason = reason;

      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(body);

      expect(response.status).toBe(400);
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM commercial.plans WHERE plan_key = $1`, [
        planKey,
      ]);
      expect(count).toBe(0);
      expect(await auditRowsFor(planKey)).toEqual([]);
    });

    /**
     * The case `@MinLength(3)` does NOT cover.
     *
     * Three spaces satisfy the decorator and are not a reason. The service
     * trims, which is why the requirement is stated there and not only on the
     * DTO — and it is why this case exists rather than being assumed covered by
     * the one above it.
     */
    it('refuses a WHITESPACE-ONLY reason, which the length decorator alone would accept', async () => {
      const planKey = nextKey('blankreason');
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: '     ' });

      expect(response.status).toBe(400);
      expect(response.body?.error?.code ?? response.body?.code).toBe('COMMERCIAL_REASON_REQUIRED');

      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM commercial.plans WHERE plan_key = $1`, [
        planKey,
      ]);
      expect(count).toBe(0);
      expect(await auditRowsFor(planKey)).toEqual([]);
    });

    it('records the TRIMMED reason, not the raw string', async () => {
      const planKey = nextKey('trimmed');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: '   opening a plan key for Q1   ' })
        .expect(201);

      const rows = await auditRowsFor(planKey);
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('opening a plan key for Q1');
    });
  });

  // =========================================================================
  // §C. Exactly one audit record per successful mutation
  // =========================================================================

  describe('§C audit records', () => {
    it('writes exactly ONE row per successful mutation, and none for a failure', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('audited');

      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'opening the plan key' })
        .expect(201);
      expect(await auditRowsFor(planKey)).toHaveLength(1);

      await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(planVersionBody(schedule.id))
        .expect(201);
      expect(await auditRowsFor(`${planKey}@1`)).toHaveLength(1);

      await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions/1/publish`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'publishing the first version' })
        .expect(201);

      // Draft + publish, in order, and nothing else.
      const versionRows = await auditRowsFor(`${planKey}@1`);
      expect(versionRows.map((r) => r.action)).toEqual([
        'commercial.plan_version_drafted',
        'commercial.plan_version_published',
      ]);

      // A refused second publish adds nothing.
      await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions/1/publish`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'publishing the same version again' })
        .expect(409);
      expect(await auditRowsFor(`${planKey}@1`)).toHaveLength(2);
    });

    it('attributes every row to the SESSION actor', async () => {
      const planKey = nextKey('actor');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'checking the recorded actor' })
        .expect(201);

      const rows = await auditRowsFor(planKey);
      expect(rows[0].actor_user_id).toBe(admin.id);
    });

    /**
     * THE TRANSACTIONAL GUARANTEE, probed rather than assumed.
     *
     * `AdminAuditService.record` is made to fail. If the audit row and the
     * domain change were not in ONE transaction, the version would publish and
     * the record would simply be missing — which is `GAP-02`'s bug class
     * exactly. The assertion is that the version is STILL A DRAFT afterwards.
     */
    it('rolls the DOMAIN change back when the audit write fails', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('rollback');
      await catalogue.createPlan(admin.id, planKey, 'setting up the rollback probe');
      const draft = await catalogue.createPlanVersionDraft(
        admin.id,
        {
          planKey,
          priceScheduleVersionId: schedule.id,
          autoAssignable: false,
          activationStartsAt: new Date(T0),
          activationEndsAt: null,
          terms: {
            displayName: 'about to fail',
            billingTermDays: null,
            includedBookingCredits: 0,
            staffSeats: 0,
            includedLocations: 0,
            capabilityKeys: [],
          },
        },
        'setting up the rollback probe',
      );

      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));

      await expect(
        catalogue.publishPlanVersion(admin.id, planKey, draft.version, 'publishing while the audit log is unavailable'),
      ).rejects.toThrow('audit unavailable');

      expect(spy).toHaveBeenCalledTimes(1);

      const [row] = await dataSource.query(`SELECT lifecycle_state, published_at FROM commercial.plan_versions WHERE id = $1`, [
        draft.id,
      ]);
      expect(row.lifecycle_state).toBe('draft');
      expect(row.published_at).toBeNull();

      // And no partial audit state either.
      const rows = await auditRowsFor(`${planKey}@${draft.version}`);
      expect(rows.map((r) => r.action)).toEqual(['commercial.plan_version_drafted']);
    });

    it('the rollback probe is not vacuous: the same call succeeds once the audit write works', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('rollback-control');
      await catalogue.createPlan(admin.id, planKey, 'setting up the rollback control');
      const draft = await catalogue.createPlanVersionDraft(
        admin.id,
        {
          planKey,
          priceScheduleVersionId: schedule.id,
          autoAssignable: false,
          activationStartsAt: new Date(T0),
          activationEndsAt: null,
          terms: {
            displayName: 'will succeed',
            billingTermDays: null,
            includedBookingCredits: 0,
            staffSeats: 0,
            includedLocations: 0,
            capabilityKeys: [],
          },
        },
        'setting up the rollback control',
      );

      const published = await catalogue.publishPlanVersion(
        admin.id,
        planKey,
        draft.version,
        'publishing with a working audit log',
      );
      expect(published.lifecycleState).toBe('published');
      expect(await auditRowsFor(`${planKey}@${draft.version}`)).toHaveLength(2);
    });
  });

  // =========================================================================
  // §D. Adversarial payloads
  // =========================================================================

  describe('§D adversarial payloads', () => {
    it('REJECTS an unknown field rather than ignoring it', async () => {
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey: nextKey('unknown'), reason: 'a body with a field nothing declares', surpriseField: 'x' });
      expect(response.status).toBe(400);
    });

    it.each([
      'actorUserId',
      'createdByUserId',
      'publishedByUserId',
      'retiredByUserId',
      'ownerUserId',
      'subscriberId',
      'userId',
    ])('REJECTS a forged `%s` in the body, because no shape declares one', async (field) => {
      const planKey = nextKey('forged');
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'attempting to attribute this to somebody else', [field]: customer.id });

      expect(response.status).toBe(400);
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM commercial.plans WHERE plan_key = $1`, [
        planKey,
      ]);
      expect(count).toBe(0);
    });

    it('records the SESSION actor even when a forged one would have been plausible', async () => {
      // The positive half: the same request minus the forged field succeeds and
      // is attributed to the caller. Without this the rejections above would be
      // consistent with the route being broken.
      const planKey = nextKey('honest');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'the same request without the forged field' })
        .expect(201);

      const [row] = await dataSource.query(`SELECT created_by_user_id FROM commercial.plans WHERE plan_key = $1`, [
        planKey,
      ]);
      expect(row.created_by_user_id).toBe(admin.id);
      expect(row.created_by_user_id).not.toBe(customer.id);
    });

    it('REJECTS a forged lifecycle state: publication is a route, not a field', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('forged-state');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'setting up a forged-state probe' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(planVersionBody(schedule.id, { lifecycleState: 'published' }));
      expect(response.status).toBe(400);
    });

    it('REJECTS a malformed key rather than storing it', async () => {
      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey: 'not a valid key!', reason: 'a key with characters the pattern forbids' });
      expect(response.status).toBe(400);
    });

    it('REJECTS a fractional or negative allowance at the edge of the API', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('badcredits');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'setting up an allowance-validation probe' })
        .expect(201);

      for (const includedBookingCredits of [-1, 1.5]) {
        const response = await request(app.getHttpServer())
          .post(`${BASE}/plans/${planKey}/versions`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(planVersionBody(schedule.id, { includedBookingCredits }));
        expect(response.status).toBe(400);
      }
    });

    it('accepts a well-formed body, so the rejections above are a boundary and not a wall', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('accepted');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'the control for the adversarial payload cases' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(planVersionBody(schedule.id));
      expect(response.status).toBe(201);
      expect(response.body?.data?.lifecycleState ?? response.body?.lifecycleState).toBe('draft');
    });
  });

  // =========================================================================
  // §E. What the reads do not disclose
  // =========================================================================

  describe('§E read disclosure', () => {
    it('never returns actor identity on a plan-version read', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('disclosure');
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: 'setting up a disclosure probe' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(planVersionBody(schedule.id))
        .expect(201);
      await request(app.getHttpServer())
        .post(`${BASE}/plans/${planKey}/versions/1/publish`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'publishing before reading it back' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`${BASE}/plans/${planKey}/versions/1`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const serialised = JSON.stringify(response.body);
      // The administrator's id is genuinely on the row -- proved next -- so its
      // absence from the body is a decision rather than an accident.
      expect(serialised).not.toContain(admin.id);
      expect(serialised).not.toContain('publishedByUserId');
      expect(serialised).not.toContain('createdByUserId');
      // The positive control: the response IS the version, not an empty object.
      expect(serialised).toContain('"lifecycleState":"published"');

      const [row] = await dataSource.query(
        `SELECT published_by_user_id FROM commercial.plan_versions WHERE plan_key = $1 AND version = 1`,
        [planKey],
      );
      expect(row.published_by_user_id).toBe(admin.id);
    });

    it('never returns audit internals such as the reason or the correlation id', async () => {
      const planKey = nextKey('no-audit-leak');
      const secret = 'a reason that must not appear in any catalogue read';
      await request(app.getHttpServer())
        .post(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ planKey, reason: secret })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`${BASE}/plans`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(secret);
      // And the reason really was recorded, so the absence above is meaningful.
      expect((await auditRowsFor(planKey))[0].reason).toBe(secret);
    });

    it('exposes no seller-facing route on this surface', async () => {
      const server = app.getHttpServer();
      // Every shape #56, #57 and #58 will own. None exists yet, and a 404 here
      // is the evidence that this story stayed inside its boundary.
      for (const path of [
        `${BASE}/subscriptions`,
        `${BASE}/purchases`,
        `${BASE}/grants`,
        `${BASE}/balance`,
        `${BASE}/plans/${T1}/subscribe`,
      ]) {
        const response = await request(server).post(path).set('Authorization', `Bearer ${admin.accessToken}`).send({});
        expect(response.status).toBe(404);
      }
    });
  });
});
