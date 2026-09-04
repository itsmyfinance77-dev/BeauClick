import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from 'uuidv7';

import { PRIVILEGED_CAPABILITIES } from '@beauclick/auth';
import {
  OWNER_ROLE_AUDIT_ACTIONS,
  OWNER_ROLE_AUDIT_REASONS,
  OWNER_ROLE_MIGRATION_ACTOR_LABEL,
  OWNER_ROLE_SYSTEM_ACTOR_LABEL,
} from '@beauclick/identity';
import { CommercialCatalogueService } from '@beauclick/commercial-policy';
import { PrivacySweepService } from '@beauclick/privacy';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/** Well before now, so the published base version is ACTIVE during the run. */
const ACTIVE_FROM = new Date('2020-01-01T00:00:00.000Z');

/** The migration this suite re-executes to prove SQL-level idempotency and predicates. */
const BACKFILL_SQL_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'database',
  'migrations',
  'identity',
  '20260905800001_backfill_seller_owner_roles.sql',
);

/**
 * The seller OWNER role lifecycle against a real PostgreSQL server — V3.3 Bug
 * #75, `V33-DEC-021`.
 *
 * ## Why the evidence is here and not on the fast layer
 *
 * Every claim this bug makes is about a REQUEST meeting real rows: that a role
 * row and an ownership row commit together or not at all, that a failed
 * transaction leaves neither, that `ON CONFLICT DO NOTHING` arbitrates a race
 * between the live trigger and the migration, that a `text[]` column stays in
 * sync, that an audit row lands in a table the application cannot UPDATE or
 * DELETE, and — the point of the whole story — that a token issued AFTER a
 * grant differs from one issued before it. pg-mem honours no ROLLBACK, has no
 * real primary-key arbitration under concurrency, and runs no PL/pgSQL, so none
 * of that can be observed there.
 *
 * The pure halves are proved fast, where they belong: the port shapes and the
 * "called with the session owner, on the transaction's manager" contract in
 * `services/provider` and `services/business`; the closed audit vocabulary in
 * `services/identity`.
 *
 * ## The whole suite drives the REAL production path
 *
 * Accounts come from `POST /api/v1/auth/dev-login`, which the docblock in
 * `dev-qa-login.ts` states plainly: it is the same `resolveOrCreate` and the
 * same `TokenService.issuePair` a real OTP login uses, skipping only the SMS
 * code nobody can read in a test. Professionals and businesses are created
 * through `POST /api/v1/providers` and `POST /api/v1/businesses`. Tokens are
 * refreshed through `POST /api/v1/auth/refresh`.
 *
 * That matters more here than in most suites. #75 exists precisely because the
 * production path granted only `customer` while the test harness seeded roles
 * explicitly — a suite that used `seedUser(['professional'])` throughout would
 * have passed on the day the bug shipped, and did. `seedUser` appears below
 * only where a row must PREDATE the grant path, which is exactly what the
 * backfill is for.
 */
describePg('seller owner role lifecycle — ownership triggers, backfill, token timing (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let sweep: PrivacySweepService;

  let phoneSequence = 0;
  /**
   * A phone the DTO actually accepts.
   *
   * `DevQaLoginDto` requires `^(\+98|0098|98|0)?9\d{9}$` — ten digits after the
   * country code. Other suites get away with a shorter shape because `seedUser`
   * writes the row directly and never meets the DTO; this suite goes through the
   * real login route, so the number has to be real.
   */
  const nextPhone = (): string => `+98915${String(1000000 + (phoneSequence += 1)).slice(-7)}`;
  const nextKey = (prefix: string): string => `${prefix}-${(phoneSequence += 1)}-${Date.now() % 100000}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
    sweep = app.get(PrivacySweepService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // Re-evaluated per request by the controller, so it is set per test rather
    // than once — and cleared afterwards, so no other suite inherits the seam.
    process.env.DEV_QA_LOGIN = '1';
  });

  afterEach(() => {
    delete process.env.DEV_QA_LOGIN;
    delete process.env.DEV_QA_LOGIN_PHONES;
  });

  // =========================================================================
  // Real-path helpers
  // =========================================================================

  interface LiveSession {
    userId: string;
    phone: string;
    accessToken: string;
    refreshToken: string;
  }

  /**
   * A brand-new account through the real login route.
   *
   * The account did not exist a moment ago, so this exercises
   * `AccountResolverService.resolveOrCreate` -> `RoleService.assignDefaultRole`
   * -> `TokenService.issuePair` exactly as a first OTP verification does.
   */
  async function login(phone = nextPhone()): Promise<LiveSession> {
    process.env.DEV_QA_LOGIN_PHONES = phone;
    const res = await request(app.getHttpServer()).post('/api/v1/auth/dev-login').send({ phone }).expect(200);
    return {
      userId: res.body.data.user.id,
      phone,
      accessToken: res.body.data.accessToken,
      refreshToken: res.body.data.refreshToken,
    };
  }

  /** Rotates the session through the real refresh route and returns the NEW pair. */
  async function refresh(session: LiveSession): Promise<LiveSession> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    return { ...session, accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
  }

  function claimsOf(accessToken: string): { roles: string[]; capabilities: string[] } {
    return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
  }

  async function createProfessional(session: LiveSession, displayName = 'متخصص آزمون'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ displayName })
      .expect(201);
    return res.body.data.id;
  }

  async function createBusiness(session: LiveSession, displayName = 'کسب‌وکار آزمون'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/businesses')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ displayName })
      .expect(201);
    return res.body.data.id;
  }

  async function rolesOf(userId: string): Promise<string[]> {
    const rows = await dataSource.query(
      `SELECT role_slug FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
      [userId],
    );
    return rows.map((r: { role_slug: string }) => r.role_slug);
  }

  async function denormalizedRolesOf(userId: string): Promise<string[]> {
    const rows = await dataSource.query(`SELECT roles FROM identity.users WHERE id = $1`, [userId]);
    return [...(rows[0]?.roles ?? [])].sort();
  }

  async function ownerRoleAuditRows(
    userId: string,
  ): Promise<Array<{ action: string; actor_user_id: string | null; actor_label: string | null; reason: string }>> {
    return dataSource.query(
      `SELECT action, actor_user_id, actor_label, reason
         FROM admin.admin_audit_log
        WHERE target_type = 'identity.user_role' AND target_id = $1
        ORDER BY created_at, action`,
      [userId],
    );
  }

  /** Re-executes the backfill's own SQL, exactly as the migration runner would. */
  async function runBackfillSql(): Promise<void> {
    await dataSource.query(readFileSync(BACKFILL_SQL_PATH, 'utf8'));
  }

  /**
   * A published, auto-assignable, zero-price base version, so #69's surface has
   * something to sell.
   *
   * Deliberately the same sequence `seller-subscription-surface.pg-spec.ts`
   * uses: the real administrator service, through the real lifecycle, rather
   * than rows inserted behind it. A base workspace assembled by hand would
   * prove #69's routes work against a shape only this suite produces.
   */
  async function publishedBaseVersion(admin: SeededUser): Promise<{ planKey: string; version: number }> {
    const scheduleKey = nextKey('sched');
    await catalogue.createPriceSchedule(admin.id, scheduleKey, 'seller_plan', 'suite setup');
    const scheduleDraft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey,
        displayName: `${scheduleKey} v1`,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: 1,
          maxPurchaseQuantity: 1,
          uiPresetQuantities: [],
          tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
        },
      },
      'suite setup',
    );
    const schedule = await catalogue.publishScheduleVersion(admin.id, scheduleKey, scheduleDraft.version, 'suite setup');

    const planKey = nextKey('plan');
    await catalogue.createPlan(admin.id, planKey, 'suite setup');
    const draft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: schedule.id,
        autoAssignable: true,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          displayName: planKey,
          billingTermDays: null,
          includedBookingCredits: 0,
          staffSeats: 0,
          includedLocations: 0,
          capabilityKeys: [],
        },
      },
      'suite setup',
    );
    const published = await catalogue.publishPlanVersion(admin.id, planKey, draft.version, 'suite setup');
    return { planKey, version: published.version };
  }

  /**
   * A second published, zero-price version a seller can actually SELECT.
   *
   * The base version is auto-assignable, so a workspace already sits on it the
   * moment it is initialized and re-selecting it is a replay — `#56a` answers
   * `409 selection_already_applied`, correctly. Proving a seller can select
   * therefore needs a DIFFERENT published version, which is what this is.
   */
  async function selectablePlanVersion(admin: SeededUser): Promise<{ planKey: string; version: number }> {
    const scheduleKey = nextKey('sched');
    await catalogue.createPriceSchedule(admin.id, scheduleKey, 'seller_plan', 'suite setup');
    const scheduleDraft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey,
        displayName: `${scheduleKey} v1`,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: 1,
          maxPurchaseQuantity: 1,
          uiPresetQuantities: [],
          tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
        },
      },
      'suite setup',
    );
    const schedule = await catalogue.publishScheduleVersion(admin.id, scheduleKey, scheduleDraft.version, 'suite setup');

    const planKey = nextKey('plan');
    await catalogue.createPlan(admin.id, planKey, 'suite setup');
    const draft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: schedule.id,
        // NOT auto-assignable: exactly one version may be, and the base
        // workspace already holds that slot.
        autoAssignable: false,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          displayName: planKey,
          billingTermDays: null,
          includedBookingCredits: 0,
          staffSeats: 0,
          includedLocations: 0,
          capabilityKeys: [],
        },
      },
      'suite setup',
    );
    const published = await catalogue.publishPlanVersion(admin.id, planKey, draft.version, 'suite setup');
    return { planKey, version: published.version };
  }

  /**
   * Runs `run()` with a role slug temporarily absent from `identity.roles`,
   * then restores it and every capability link.
   *
   * That is the honest way to make the grant fail: `assignOwnerRole` resolves
   * the slug from the data and raises `RoleNotFoundException` when it is
   * missing, so removing the row exercises the REAL failure path rather than a
   * mock throwing on cue. The exception is a `VALIDATION_ERROR`, which is why
   * the creation routes answer `400` inside this block.
   *
   * The restore is in a `finally` and is not optional: `identity.roles` is
   * catalogue data that `resetDatabase` deliberately does not truncate, so a
   * deletion left behind here would outlive the test, the suite and the run.
   */
  async function withRoleSlugMissing<T>(slug: string, run: () => Promise<T>): Promise<T> {
    const [row] = await dataSource.query(`SELECT * FROM identity.roles WHERE slug = $1`, [slug]);
    const links = await dataSource.query(
      `SELECT capability_slug FROM identity.role_capabilities WHERE role_slug = $1`,
      [slug],
    );
    await dataSource.query(`DELETE FROM identity.role_capabilities WHERE role_slug = $1`, [slug]);
    await dataSource.query(`DELETE FROM identity.roles WHERE slug = $1`, [slug]);
    try {
      return await run();
    } finally {
      await dataSource.query(
        `INSERT INTO identity.roles (slug, name, description, is_privileged, is_default)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
        [row.slug, row.name, row.description, row.is_privileged, row.is_default],
      );
      for (const link of links) {
        await dataSource.query(
          `INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [slug, link.capability_slug],
        );
      }
    }
  }

  // =========================================================================
  // §1. The trigger — professional
  // =========================================================================

  describe('§1 professional ownership grants the professional role', () => {
    it('grants it atomically on creation, keeps customer, and syncs the denormalized column', async () => {
      const seller = await login();

      // The state #75 describes: a real account holds customer alone.
      expect(await rolesOf(seller.userId)).toEqual(['customer']);
      expect(claimsOf(seller.accessToken).roles).toEqual(['customer']);

      await createProfessional(seller);

      expect(await rolesOf(seller.userId)).toEqual(['customer', 'professional']);
      expect(await denormalizedRolesOf(seller.userId)).toEqual(['customer', 'professional']);
    });

    it('grants nothing to an account that creates nothing', async () => {
      const bystander = await login();
      expect(await rolesOf(bystander.userId)).toEqual(['customer']);
    });

    it('is idempotent: a replayed creation is refused and writes no second role or audit row', async () => {
      const seller = await login();
      await createProfessional(seller);

      // `ProviderAlreadyExistsException` — the pre-existing uniqueness rule,
      // unchanged by #75.
      await request(app.getHttpServer())
        .post('/api/v1/providers')
        .set('Authorization', `Bearer ${seller.accessToken}`)
        .send({ displayName: 'دومی' })
        .expect(409);

      expect(await rolesOf(seller.userId)).toEqual(['customer', 'professional']);
      const audit = await ownerRoleAuditRows(seller.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe(OWNER_ROLE_AUDIT_ACTIONS.professionalGranted);
    });

    it('grants nothing on verification submission or on an approval decision', async () => {
      const seller = await login();
      await createProfessional(seller);
      const before = await rolesOf(seller.userId);

      const refreshed = await refresh(seller);
      const submitted = await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${refreshed.accessToken}`)
        .send({ note: 'مدارک ارسال شد' })
        .expect(201);
      expect(await rolesOf(seller.userId)).toEqual(before);

      const moderator = await seedUser(app, dataSource, nextPhone(), ['customer', 'moderator']);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.body.data.id}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ decision: 'approve', reason: 'مدارک کامل است' })
        .expect(201);

      // Approval changes verification status and nothing about roles.
      expect(await rolesOf(seller.userId)).toEqual(before);
      expect(await ownerRoleAuditRows(seller.userId)).toHaveLength(1);
    });

    it('grants nothing to a reader of somebody else s profile', async () => {
      const seller = await login();
      const professionalId = await createProfessional(seller);

      const reader = await login();
      await request(app.getHttpServer())
        .get(`/api/v1/providers/${professionalId}`)
        .set('Authorization', `Bearer ${reader.accessToken}`)
        .expect(200);

      expect(await rolesOf(reader.userId)).toEqual(['customer']);
    });
  });

  // =========================================================================
  // §2. The trigger — business
  // =========================================================================

  describe('§2 business ownership grants the business role', () => {
    it('grants it atomically on creation and keeps customer', async () => {
      const owner = await login();
      expect(await rolesOf(owner.userId)).toEqual(['customer']);

      await createBusiness(owner);

      expect(await rolesOf(owner.userId)).toEqual(['business', 'customer']);
      expect(await denormalizedRolesOf(owner.userId)).toEqual(['business', 'customer']);
      const audit = await ownerRoleAuditRows(owner.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe(OWNER_ROLE_AUDIT_ACTIONS.businessGranted);
    });

    it('grants no professional role to a business owner', async () => {
      const owner = await login();
      await createBusiness(owner);
      expect(await rolesOf(owner.userId)).not.toContain('professional');
    });

    it('is idempotent: a replayed creation is refused and writes no second role or audit row', async () => {
      const owner = await login();
      await createBusiness(owner);

      await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ displayName: 'دومی' })
        .expect(409);

      expect(await rolesOf(owner.userId)).toEqual(['business', 'customer']);
      expect(await ownerRoleAuditRows(owner.userId)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §3. Staff boundary — `V33-DEC-021` Ruling 6
  // =========================================================================

  describe('§3 business_staff grants no global role', () => {
    async function inviteAndAccept(
      businessOwner: LiveSession,
      businessId: string,
      member: LiveSession,
      role: 'manager' | 'staff',
      professionalId: string | null,
    ): Promise<void> {
      const ownerToken = (await refresh(businessOwner)).accessToken;
      const invited = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${businessId}/staff`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: member.userId, role, ...(professionalId ? { professionalId } : {}) })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/me/business-staff/${invited.body.data.id}/accept`)
        .set('Authorization', `Bearer ${member.accessToken}`)
        .send({})
        .expect(201);
    }

    it('grants no business role to an active MANAGER', async () => {
      const bizOwner = await login();
      const businessId = await createBusiness(bizOwner);
      const manager = await login();

      await inviteAndAccept(bizOwner, businessId, manager, 'manager', null);

      expect(await rolesOf(manager.userId)).toEqual(['customer']);
      expect(await ownerRoleAuditRows(manager.userId)).toHaveLength(0);
    });

    it('grants no business role to an active STAFF member', async () => {
      const bizOwner = await login();
      const businessId = await createBusiness(bizOwner);
      const member = await login();

      await inviteAndAccept(bizOwner, businessId, member, 'staff', null);

      expect(await rolesOf(member.userId)).toEqual(['customer']);
    });

    it('lets a staff professional keep their own professional role, through joining and leaving', async () => {
      const bizOwner = await login();
      const businessId = await createBusiness(bizOwner);

      const staffPro = await login();
      const professionalId = await createProfessional(staffPro, 'متخصص کارمند');
      expect(await rolesOf(staffPro.userId)).toEqual(['customer', 'professional']);

      await inviteAndAccept(bizOwner, businessId, staffPro, 'staff', professionalId);
      // Joining grants no business role and removes no professional role.
      expect(await rolesOf(staffPro.userId)).toEqual(['customer', 'professional']);

      const membership = await dataSource.query(
        `SELECT id FROM business.business_staff WHERE user_id = $1 AND status = 'active'`,
        [staffPro.userId],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/me/business-staff/${membership[0].id}/leave`)
        .set('Authorization', `Bearer ${staffPro.accessToken}`)
        .send({})
        .expect(201);

      // Departure revokes nothing they own independently.
      expect(await rolesOf(staffPro.userId)).toEqual(['customer', 'professional']);
    });
  });

  // =========================================================================
  // §4. Dual owner — `V33-DEC-021` Ruling 4
  // =========================================================================

  describe('§4 dual ownership', () => {
    it('grants both roles regardless of creation order, with a deterministic capability union', async () => {
      const professionalFirst = await login();
      await createProfessional(professionalFirst, 'ترتیب اول');
      await createBusiness(professionalFirst, 'ترتیب اول');

      const businessFirst = await login();
      await createBusiness(businessFirst, 'ترتیب دوم');
      await createProfessional(businessFirst, 'ترتیب دوم');

      const expected = ['business', 'customer', 'professional'];
      expect(await rolesOf(professionalFirst.userId)).toEqual(expected);
      expect(await rolesOf(businessFirst.userId)).toEqual(expected);

      const a = claimsOf((await refresh(professionalFirst)).accessToken);
      const b = claimsOf((await refresh(businessFirst)).accessToken);

      // Order-independent AND de-duplicated: `bc_manage_own_profile` is carried
      // by both seller roles and must appear exactly once.
      expect(a.roles).toEqual(b.roles);
      expect(a.capabilities).toEqual(b.capabilities);
      expect(a.capabilities).toEqual([...new Set(a.capabilities)].sort());
      expect(a.capabilities.filter((c) => c === 'bc_manage_own_profile')).toHaveLength(1);
      expect(a.capabilities).toContain('bc_manage_own_subscription');
      // `customer` survives, so the customer-only capabilities are still there.
      expect(a.capabilities).toEqual(expect.arrayContaining(['bc_book_service', 'bc_view_own_orders', 'bc_use_ai_assistant']));
    });

    it('writes one audit row per role for a dual owner, and no more', async () => {
      const dual = await login();
      await createProfessional(dual, 'دوگانه');
      await createBusiness(dual, 'دوگانه');

      const audit = await ownerRoleAuditRows(dual.userId);
      expect(audit.map((r) => r.action).sort()).toEqual(
        [OWNER_ROLE_AUDIT_ACTIONS.businessGranted, OWNER_ROLE_AUDIT_ACTIONS.professionalGranted].sort(),
      );
      // No human actor is fabricated for either.
      expect(audit.every((r) => r.actor_user_id === null)).toBe(true);
      expect(audit.every((r) => r.actor_label === OWNER_ROLE_SYSTEM_ACTOR_LABEL)).toBe(true);
    });
  });

  // =========================================================================
  // §5. Atomicity — `V33-DEC-021` Ruling 8
  // =========================================================================

  describe('§5 ownership and role commit together', () => {
    it('rolls the professional profile back when the role grant fails', async () => {
      const seller = await login();

      await withRoleSlugMissing('professional', async () => {
        await request(app.getHttpServer())
          .post('/api/v1/providers')
          .set('Authorization', `Bearer ${seller.accessToken}`)
          .send({ displayName: 'نباید بماند' })
          .expect(400);
      });

      const professionals = await dataSource.query(`SELECT id FROM provider.professionals WHERE owner_id = $1`, [
        seller.userId,
      ]);
      expect(professionals).toHaveLength(0);
      expect(await rolesOf(seller.userId)).toEqual(['customer']);
      // No outbox row either: the whole transaction went.
      const outbox = await dataSource.query(`SELECT id FROM provider.outbox_events`);
      expect(outbox).toHaveLength(0);
    });

    it('rolls the business back when the role grant fails', async () => {
      const owner = await login();

      await withRoleSlugMissing('business', async () => {
        await request(app.getHttpServer())
          .post('/api/v1/businesses')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ displayName: 'نباید بماند' })
          .expect(400);
      });

      const businesses = await dataSource.query(`SELECT id FROM business.businesses WHERE owner_id = $1`, [owner.userId]);
      expect(businesses).toHaveLength(0);
      expect(await rolesOf(owner.userId)).toEqual(['customer']);
      const outbox = await dataSource.query(`SELECT id FROM business.outbox_events`);
      expect(outbox).toHaveLength(0);
    });

    it('leaves no audit row behind when the ownership transaction rolls back', async () => {
      /*
       * The third member of the transaction, proved from the direction the
       * application role can actually reach.
       *
       * `admin.admin_audit_log` is owned by `beauclick_admin_audit_owner` and
       * the application holds INSERT and SELECT only -- it cannot ALTER the
       * table to plant a failing constraint, and granting it that power in
       * order to run a test would spend the very guarantee the role separation
       * buys. So the lever is the role lookup, and what this case establishes
       * is the property that matters: ownership, role and audit share ONE fate.
       *
       * The complementary direction -- an audit failure aborting the grant --
       * is proved fast, in `services/identity/src/rbac/owner-role.spec.ts`,
       * where a throwing audit collaborator can be injected without needing any
       * database privilege at all.
       */
      const seller = await login();
      const [before] = await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE target_type = 'identity.user_role'`,
      );

      await withRoleSlugMissing('professional', async () => {
        await request(app.getHttpServer())
          .post('/api/v1/providers')
          .set('Authorization', `Bearer ${seller.accessToken}`)
          .send({ displayName: 'نباید بماند' })
          .expect(400);
      });

      const [after] = await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE target_type = 'identity.user_role'`,
      );
      expect(after.n).toBe(before.n);
      expect(await ownerRoleAuditRows(seller.userId)).toHaveLength(0);
      expect(await rolesOf(seller.userId)).toEqual(['customer']);
    });
  });

  // =========================================================================
  // §6. Backfill — `V33-DEC-021` Ruling 7
  // =========================================================================

  describe('§6 migration backfill', () => {
    /**
     * `resetDatabase` truncates the migration's effects away, so every case here
     * seeds rows that PREDATE the grant path and then re-executes the migration's
     * own SQL. `seedUser` is used deliberately: it writes the user row directly,
     * which is exactly the state an account created before #75 shipped is in.
     */
    it('grants professional, business and both, and nothing to a staff-only user', async () => {
      const proOwner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await seedProfessional(dataSource, proOwner.id, 'متخصص قدیمی');

      const bizOwner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const biz = await seedBusiness(dataSource, bizOwner.id, 'کسب‌وکار قدیمی');

      const dualOwner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await seedProfessional(dataSource, dualOwner.id, 'متخصص دوگانه');
      await seedBusiness(dataSource, dualOwner.id, 'کسب‌وکار دوگانه');

      const staffOnly = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, NULL, 'manager', 'active', $4)`,
        [uuidv7(), biz.id, staffOnly.id, bizOwner.id],
      );

      await runBackfillSql();

      expect(await rolesOf(proOwner.id)).toEqual(['customer', 'professional']);
      expect(await rolesOf(bizOwner.id)).toEqual(['business', 'customer']);
      expect(await rolesOf(dualOwner.id)).toEqual(['business', 'customer', 'professional']);
      // The manager owns nothing, so the backfill has nothing to give them.
      expect(await rolesOf(staffOnly.id)).toEqual(['customer']);
      expect(await ownerRoleAuditRows(staffOnly.id)).toHaveLength(0);
    });

    it('grants nothing to a soft-deleted owner or an erased user', async () => {
      const deletedPro = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const pro = await seedProfessional(dataSource, deletedPro.id, 'متخصص حذف‌شده');
      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [pro.id]);

      const erased = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await seedProfessional(dataSource, erased.id, 'متخصص پاک‌شده');
      await dataSource.query(`UPDATE identity.users SET deleted_at = now() WHERE id = $1`, [erased.id]);
      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [erased.id]);

      await runBackfillSql();

      expect(await rolesOf(deletedPro.id)).toEqual(['customer']);
      // Erasure already removed every role row; the backfill must not undo that.
      expect(await rolesOf(erased.id)).toEqual([]);
    });

    it('is idempotent at the SQL level: a rerun inserts nothing and preserves granted_at', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await seedProfessional(dataSource, owner.id, 'متخصص قدیمی');
      await seedBusiness(dataSource, owner.id, 'کسب‌وکار قدیمی');

      await runBackfillSql();
      const first = await dataSource.query(
        `SELECT role_slug, granted_at FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
        [owner.id],
      );
      const firstAudit = await ownerRoleAuditRows(owner.id);

      await runBackfillSql();
      await runBackfillSql();

      const second = await dataSource.query(
        `SELECT role_slug, granted_at FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
        [owner.id],
      );
      expect(second).toEqual(first);
      // The audit trail records what happened, not what was attempted.
      expect(await ownerRoleAuditRows(owner.id)).toEqual(firstAudit);
      expect(firstAudit).toHaveLength(2);
      expect(firstAudit.every((r) => r.actor_label === OWNER_ROLE_MIGRATION_ACTOR_LABEL)).toBe(true);
      expect(firstAudit.every((r) => r.actor_user_id === null)).toBe(true);
    });

    it('preserves an administrator-created row rather than rewriting it', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const operator = await seedUser(app, dataSource, nextPhone(), ['customer', 'platform_operator']);
      await seedProfessional(dataSource, owner.id, 'متخصص قدیمی');

      await dataSource.query(
        `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason) VALUES ($1, 'professional', $2, $3)`,
        [owner.id, operator.id, 'granted by hand before the backfill existed'],
      );
      const before = await dataSource.query(
        `SELECT granted_by, reason, granted_at FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'professional'`,
        [owner.id],
      );

      await runBackfillSql();

      const after = await dataSource.query(
        `SELECT granted_by, reason, granted_at FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'professional'`,
        [owner.id],
      );
      // `ON CONFLICT DO NOTHING` means the administrator's provenance survives
      // untouched. `V33-DEC-021` Ruling 7 requires exactly that, and Ruling 11
      // is why no `source` column is needed to achieve it.
      expect(after).toEqual(before);
      expect(after[0].granted_by).toBe(operator.id);
      // Nothing inserted means nothing audited.
      expect(await ownerRoleAuditRows(owner.id)).toHaveLength(0);
    });

    it('fails explicitly rather than silently when a required role slug is absent', async () => {
      // `identity.roles` is deliberately NOT in `RESETTABLE_TABLES` -- it is
      // catalogue data every other suite depends on -- so this case restores
      // what it removes. A test that left the role deleted would poison every
      // later suite in the run AND the database itself.
      await withRoleSlugMissing('professional', async () => {
        await expect(runBackfillSql()).rejects.toThrow(/missing the professional role/);
      });
      expect(await dataSource.query(`SELECT slug FROM identity.roles WHERE slug = 'professional'`)).toHaveLength(1);
    });

    it('never references business_staff or verification_status in the executable migration', async () => {
      const sql = readFileSync(BACKFILL_SQL_PATH, 'utf8');
      // The comment block names both to explain the exclusions, so the
      // assertion is about EXECUTABLE references and not about the words.
      const executable = sql
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(executable).not.toMatch(/business_staff/);
      expect(executable).not.toMatch(/verification_status/);
    });

    it('produces one row when the live trigger and the backfill race the same owner', async () => {
      const seller = await login();
      await seedProfessional(dataSource, seller.userId, 'رقابت همزمان');

      // Genuinely concurrent, on two connections from the pool, arbitrated by
      // `user_roles`'s primary key rather than by an application-level check
      // that read-committed cannot honour.
      await Promise.all([
        runBackfillSql(),
        dataSource.query(
          `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
           VALUES ($1, 'professional', NULL, 'concurrent live trigger')
           ON CONFLICT (user_id, role_slug) DO NOTHING`,
          [seller.userId],
        ),
      ]);

      const rows = await dataSource.query(
        `SELECT role_slug FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'professional'`,
        [seller.userId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  // =========================================================================
  // §7. Token timing — `V33-DEC-021` Ruling 9
  // =========================================================================

  describe('§7 access-token timing, stated honestly', () => {
    /**
     * The case that replaces #69's stale comment.
     *
     * `seller-subscription-surface.pg-spec.ts` §5 described a capability-less
     * seller as "the state a seller is in between a role grant and their next
     * access token". Before #75 that was not an interval -- production granted
     * nothing, so it was every seller's permanent condition. It is an interval
     * NOW, and this proves both of its ends.
     */
    it('leaves the existing token unchanged and puts the role in the NEXT one', async () => {
      const seller = await login();
      const tokenBefore = seller.accessToken;

      await createProfessional(seller);

      // The database has the role immediately...
      expect(await rolesOf(seller.userId)).toContain('professional');
      // ...and the already-issued token is untouched, byte for byte. Nothing
      // rewrites a JWT in place, and nothing should appear to.
      expect(seller.accessToken).toBe(tokenBefore);
      expect(claimsOf(tokenBefore).roles).toEqual(['customer']);
      expect(claimsOf(tokenBefore).capabilities).not.toContain('bc_manage_own_subscription');

      const after = await refresh(seller);
      expect(claimsOf(after.accessToken).roles).toEqual(['customer', 'professional']);
      expect(claimsOf(after.accessToken).capabilities).toContain('bc_manage_own_subscription');
    });

    it('leaves a REMOVED role in the old token and absent from the next one', async () => {
      const seller = await login();
      await createProfessional(seller);
      const withRole = await refresh(seller);
      expect(claimsOf(withRole.accessToken).capabilities).toContain('bc_manage_own_subscription');

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'professional'`, [
        seller.userId,
      ]);

      // Still carried by the issued token. That is the documented contract for
      // a non-privileged capability, and asserting it stops a later change from
      // quietly turning it into a live check without a decision.
      expect(claimsOf(withRole.accessToken).capabilities).toContain('bc_manage_own_subscription');

      const afterRemoval = await refresh(withRole);
      expect(claimsOf(afterRemoval.accessToken).capabilities).not.toContain('bc_manage_own_subscription');
      expect(claimsOf(afterRemoval.accessToken).roles).toEqual(['customer']);
    });

    it('keeps no seller capability in PRIVILEGED_CAPABILITIES', () => {
      for (const capability of [
        'bc_manage_own_subscription',
        'bc_manage_own_profile',
        'bc_manage_own_services',
        'bc_view_own_bookings',
        'bc_manage_own_availability',
        'bc_view_own_finance',
        'bc_manage_business_staff',
      ]) {
        expect(PRIVILEGED_CAPABILITIES).not.toContain(capability);
      }
    });
  });

  // =========================================================================
  // §8. Story #69 reachability — the defect, closed
  // =========================================================================

  describe('§8 a legitimate seller reaches the subscription surface', () => {
    it('initializes D-7, selects a published zero-price plan and cancels back, after one refresh', async () => {
      const admin = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      await publishedBaseVersion(admin);
      const plan = await selectablePlanVersion(admin);

      const seller = await login();
      await createProfessional(seller);

      // The refusal #75 filed, still true for the token minted BEFORE ownership.
      await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${seller.accessToken}`)
        .send({})
        .expect(403);

      const live = await refresh(seller);

      const initialized = await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        .expect(201);
      expect(initialized.body.data.items).toHaveLength(1);
      const workspaceRef = initialized.body.data.items[0].workspaceRef;
      expect(initialized.body.data.items[0].baseWorkspace).toBe(true);

      const selected = await request(app.getHttpServer())
        .post(`/api/v1/me/subscriptions/${workspaceRef}/selection`)
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({ planKey: plan.planKey, version: plan.version })
        .expect(201);
      expect(selected.body.data.subscription.state).toBe('active');

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/me/subscriptions/${workspaceRef}/cancellation`)
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        .expect(201);
      expect(cancelled.body.data.baseWorkspace).toBe(true);
    });

    it('works for a business owner too, on their own workspace', async () => {
      const admin = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      await publishedBaseVersion(admin);

      const owner = await login();
      await createBusiness(owner);
      const live = await refresh(owner);

      const initialized = await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        .expect(201);
      expect(initialized.body.data.items).toHaveLength(1);
    });
  });

  // =========================================================================
  // §9. Negative controls — a role is never ownership
  // =========================================================================

  describe('§9 a role without ownership grants nothing', () => {
    it('refuses an unauthenticated caller and a customer-only caller', async () => {
      await request(app.getHttpServer()).post('/api/v1/me/subscriptions/initialization').send({}).expect(401);

      const customer = await login();
      await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({})
        .expect(403);
    });

    it('gives a manually granted seller role no self-scoped authority without ownership', async () => {
      const admin = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      await publishedBaseVersion(admin);

      // Every seller capability, no ownership. The capability guard passes and
      // the ownership resolver finds nothing to act on -- which is `V33-DEC-021`
      // Ruling 5 and Ruling 11's whole basis for needing no provenance model.
      const impostor = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      expect(claimsOf(impostor.accessToken).capabilities).toContain('bc_manage_own_subscription');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/me/subscriptions')
        .set('Authorization', `Bearer ${impostor.accessToken}`)
        .expect(200);
      expect(listed.body.data.items).toEqual([]);

      const initialized = await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${impostor.accessToken}`)
        .send({})
        .expect(201);
      expect(initialized.body.data.items).toEqual([]);

      const subscriptions = await dataSource.query(`SELECT id FROM commercial.seller_subscriptions`);
      expect(subscriptions).toHaveLength(0);
    });

    it('refuses a staff member presenting the employer workspaceRef', async () => {
      const admin = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      await publishedBaseVersion(admin);

      const bizOwner = await login();
      const businessId = await createBusiness(bizOwner);
      const ownerLive = await refresh(bizOwner);

      const staffPro = await login();
      const professionalId = await createProfessional(staffPro, 'کارمند متخصص');
      const staffLive = await refresh(staffPro);

      const invited = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${businessId}/staff`)
        .set('Authorization', `Bearer ${ownerLive.accessToken}`)
        .send({ userId: staffPro.userId, role: 'manager', professionalId })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/me/business-staff/${invited.body.data.id}/accept`)
        .set('Authorization', `Bearer ${staffLive.accessToken}`)
        .send({})
        .expect(201);

      const ownerWorkspaces = await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${ownerLive.accessToken}`)
        .send({})
        .expect(201);
      const employerRef = ownerWorkspaces.body.data.items[0].workspaceRef;

      // The staff member holds `bc_manage_own_subscription` -- they own a
      // professional of their own -- and still cannot reach the employer's
      // workspace. Ownership is what refuses, exactly as `V33-DEC-020` Ruling 1
      // and `V33-DEC-021` Ruling 6 require.
      await request(app.getHttpServer())
        .post(`/api/v1/me/subscriptions/${employerRef}/cancellation`)
        .set('Authorization', `Bearer ${staffLive.accessToken}`)
        .send({})
        .expect(404);
    });

    it('gives an administrator no reach over another professional through bc_manage_own_profile', async () => {
      const victim = await login();
      const professionalId = await createProfessional(victim, 'قربانی');

      const administrator = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      expect(claimsOf(administrator.accessToken).capabilities).toContain('bc_manage_own_profile');

      // Ownership refuses, and refuses without revealing existence.
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professionalId}`)
        .set('Authorization', `Bearer ${administrator.accessToken}`)
        .send({ displayName: 'تصاحب‌شده' })
        .expect(404);

      const row = await dataSource.query(`SELECT display_name FROM provider.professionals WHERE id = $1`, [
        professionalId,
      ]);
      expect(row[0].display_name).toBe('قربانی');
      expect(await rolesOf(administrator.id)).not.toContain('professional');
    });

    it('blocks self-scoped operations the instant ownership is lost, stale token or not', async () => {
      const admin = await seedUser(app, dataSource, nextPhone(), ['customer', 'administrator']);
      await publishedBaseVersion(admin);

      const seller = await login();
      const professionalId = await createProfessional(seller);
      const live = await refresh(seller);
      const initialized = await request(app.getHttpServer())
        .post('/api/v1/me/subscriptions/initialization')
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        .expect(201);
      const workspaceRef = initialized.body.data.items[0].workspaceRef;

      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [professionalId]);

      // The token still carries the role and the capability...
      expect(claimsOf(live.accessToken).capabilities).toContain('bc_manage_own_subscription');
      // ...and the workspace is gone the same instant, because ownership is
      // resolved live per request. This is `V33-DEC-021` Ruling 10's "loss of
      // ownership blocks immediately" -- no revocation machinery required.
      const listed = await request(app.getHttpServer())
        .get('/api/v1/me/subscriptions')
        .set('Authorization', `Bearer ${live.accessToken}`)
        .expect(200);
      expect(listed.body.data.items).toEqual([]);
      await request(app.getHttpServer())
        .post(`/api/v1/me/subscriptions/${workspaceRef}/cancellation`)
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        .expect(404);
    });
  });

  // =========================================================================
  // §10. Forged input
  // =========================================================================

  describe('§10 no role, capability or owner may be supplied', () => {
    it('refuses forged fields with 400 and writes neither ownership nor role', async () => {
      const attacker = await login();
      const victim = await login();

      const forgeries: Array<Record<string, unknown>> = [
        { displayName: 'ok', roleSlug: 'administrator' },
        { displayName: 'ok', roles: ['administrator'] },
        { displayName: 'ok', capabilities: ['bc_manage_platform'] },
        { displayName: 'ok', ownerId: victim.userId },
        { displayName: 'ok', userId: victim.userId },
        { displayName: 'ok', grantedBy: victim.userId },
        { displayName: 'ok', isVerifiedProfessional: true },
      ];

      for (const body of forgeries) {
        await request(app.getHttpServer())
          .post('/api/v1/providers')
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .send(body)
          .expect(400);
        await request(app.getHttpServer())
          .post('/api/v1/businesses')
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .send(body)
          .expect(400);
      }

      expect(await rolesOf(attacker.userId)).toEqual(['customer']);
      expect(await rolesOf(victim.userId)).toEqual(['customer']);
      expect(await dataSource.query(`SELECT id FROM provider.professionals`)).toHaveLength(0);
      expect(await dataSource.query(`SELECT id FROM business.businesses`)).toHaveLength(0);
    });
  });

  // =========================================================================
  // §11. Audit and privacy
  // =========================================================================

  describe('§11 audit and privacy', () => {
    it('records a fixed server-owned reason and no caller prose', async () => {
      const seller = await login();
      await createProfessional(seller, 'نامی که نباید در حسابرسی ظاهر شود');

      const audit = await ownerRoleAuditRows(seller.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0].reason).toBe(OWNER_ROLE_AUDIT_REASONS.professionalOwnershipCreated);
      expect(audit[0].reason).not.toMatch(/نامی که نباید/);
      expect(audit[0].actor_user_id).toBeNull();
      expect(audit[0].actor_label).toBe(OWNER_ROLE_SYSTEM_ACTOR_LABEL);
    });

    it('exports the subject own role assignment without naming a granting administrator', async () => {
      const seller = await login();
      await createProfessional(seller);
      const live = await refresh(seller);

      const requested = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${live.accessToken}`)
        .send({})
        // `202 Accepted`: the archive is assembled by the sweep, not inline.
        .expect(202);
      await sweep.runOnce();

      const payload = await dataSource.query(`SELECT document FROM privacy.export_payloads WHERE request_id = $1`, [
        requested.body.data.id,
      ]);
      const document = JSON.stringify(payload[0].document);
      expect(document).toContain('professional');
      // `grantedBy` is deliberately absent from the export: naming the granting
      // administrator would put another person's identity in this subject's
      // archive. For an automatic grant there is no human to name anyway.
      expect(document).not.toContain('grantedBy');
    });

    it('removes every role row on erasure, including the automatic grants', async () => {
      const seller = await login();
      await createProfessional(seller);
      await createBusiness(seller);
      expect(await rolesOf(seller.userId)).toHaveLength(3);

      const live = await refresh(seller);
      const deletion = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${live.accessToken}`)
        // The typed confirmation the route requires. An empty body is a `400`
        // by design, and this suite must not weaken that to reach the sweep.
        .send({ confirm: 'DELETE' })
        .expect(202);

      // The grace window is the product's, not this test's, so it is moved
      // rather than removed.
      await dataSource.query(
        `UPDATE privacy.data_requests SET execute_after = now() - interval '1 day' WHERE id = $1`,
        [deletion.body.data.id],
      );
      await sweep.runOnce();

      // `IdentitySubjectDataContract` deletes every `user_roles` row, so the
      // automatic grants leave with the rest. An erased account still holding a
      // live seller role would be a principal nobody can identify.
      expect(await rolesOf(seller.userId)).toEqual([]);
    });
  });

  // =========================================================================
  // §12. No side effects
  // =========================================================================

  describe('§12 the grant introduces no other effect', () => {
    it('writes no payment, ledger, subscription, credit grant or notification row', async () => {
      const seller = await login();
      await createProfessional(seller);
      await createBusiness(seller);

      for (const [label, sql] of [
        ['payment intents', 'SELECT id FROM payment.payment_intents'],
        ['orders', 'SELECT id FROM commerce.orders'],
        ['subscriptions', 'SELECT id FROM commercial.seller_subscriptions'],
        ['credit grants', 'SELECT id FROM commercial.booking_credit_grants'],
        ['notifications', 'SELECT id FROM notification.notifications'],
      ] as const) {
        const rows = await dataSource.query(sql);
        expect({ label, count: rows.length }).toEqual({ label, count: 0 });
      }

      // The only outbox rows are the ones provider and business already emitted
      // before #75 -- the grant adds no event of its own.
      const providerOutbox = await dataSource.query(`SELECT event_type FROM provider.outbox_events`);
      const businessOutbox = await dataSource.query(`SELECT event_type FROM business.outbox_events`);
      expect(providerOutbox.map((r: { event_type: string }) => r.event_type)).toEqual(['ProfessionalUpdated']);
      expect(businessOutbox.map((r: { event_type: string }) => r.event_type)).toEqual(['BusinessCreated']);
    });
  });
});
