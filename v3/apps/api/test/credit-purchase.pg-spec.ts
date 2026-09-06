import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CommercialCatalogueService,
  SellerSubscriptionService,
  WorkspaceReferenceService,
} from '@beauclick/commercial-policy';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract } from '@beauclick/subject-data';

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

/** Well before now, so a published version is ACTIVE during the run. */
const ACTIVE_FROM = new Date('2020-01-01T00:00:00.000Z');

/**
 * Custom booking-credit purchases against a real PostgreSQL server — V3.3
 * Story #57 (`#40c-1`), ADR-047, `V33-DEC-026` and `V33-DEC-027`.
 *
 * ## Why the evidence is here
 *
 * Every claim this story makes is about rows meeting constraints: that a
 * wrong-purpose binding is unwritable, that `total = unit × quantity` is the
 * database's rule and not the application's, that a snapshot cannot be edited
 * or deleted, that N concurrent submissions of one idempotency key produce one
 * row, that a rollback leaves neither purchase nor audit, and that a repricing
 * changes nothing already written. pg-mem enforces no CHECK, honours no
 * ROLLBACK, has no composite foreign keys and runs no PL/pgSQL, so none of it
 * is observable on the fast layer.
 *
 * ## The refusal cases are compared as WHOLE BODIES
 *
 * "These seven conditions are indistinguishable" is a claim about the response,
 * not about one field of it. Asserting a code at a time would pass while the
 * bodies differed somewhere else, which is exactly the leak being tested for.
 *
 * ## Non-vacuity
 *
 * Every absence has a positive control in this same suite: a schedule that DOES
 * price, a quantity that IS accepted, a party that CAN buy, a body field that
 * IS rejected. The seeded catalogue's own unavailability is asserted against a
 * configured one, so "unavailable" is never just an empty database.
 */
describePg('custom booking-credit purchases (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let subscriptions: SellerSubscriptionService;
  let references: WorkspaceReferenceService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98917${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
    subscriptions = app.get(SellerSubscriptionService);
    references = app.get(WorkspaceReferenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    baseWorkspace = null;
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // =========================================================================
  // Builders — real catalogue rows through the real administrator service
  // =========================================================================

  interface TierSpec {
    minQuantity: number;
    maxQuantity: number | null;
    unitPriceToman: number;
  }

  /** A published `booking_credit` schedule. Every number here is the TEST's, never the code's. */
  async function creditSchedule(
    options: {
      key?: string;
      tiers?: TierSpec[];
      min?: number;
      max?: number;
      activationStartsAt?: Date;
      activationEndsAt?: Date | null;
      publish?: boolean;
      purpose?: 'booking_credit' | 'seller_plan';
    } = {},
  ): Promise<{ key: string; versionId: string; version: number }> {
    const key = options.key ?? nextKey('credits');
    const purpose = options.purpose ?? 'booking_credit';
    const existing = await dataSource.query(
      'SELECT schedule_key FROM commercial.price_schedules WHERE schedule_key = $1',
      [key],
    );
    if (existing.length === 0) {
      await catalogue.createPriceSchedule(admin.id, key, purpose, 'suite setup');
    }

    const draft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey: key,
        displayName: `${key} v`,
        activationStartsAt: options.activationStartsAt ?? ACTIVE_FROM,
        activationEndsAt: options.activationEndsAt === undefined ? null : options.activationEndsAt,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: options.min ?? 1,
          maxPurchaseQuantity: options.max ?? 1000,
          uiPresetQuantities: [],
          tiers: options.tiers ?? [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 7 }],
        },
      },
      'suite setup',
    );

    if (options.publish === false) return { key, versionId: draft.id, version: draft.version };
    const published = await catalogue.publishScheduleVersion(admin.id, key, draft.version, 'suite setup');
    return { key, versionId: published.id, version: published.version };
  }

  /** A published plan version, optionally bound to a credit schedule key. */
  async function publishedPlan(
    options: { bookingCreditScheduleKey?: string | null; autoAssignable?: boolean } = {},
  ): Promise<{ planKey: string; version: number; id: string }> {
    const planSchedule = nextKey('sched');
    await catalogue.createPriceSchedule(admin.id, planSchedule, 'seller_plan', 'suite setup');
    const scheduleDraft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey: planSchedule,
        displayName: `${planSchedule} v1`,
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
    const schedule = await catalogue.publishScheduleVersion(admin.id, planSchedule, scheduleDraft.version, 'suite setup');

    const planKey = nextKey('plan');
    await catalogue.createPlan(admin.id, planKey, 'suite setup');
    const draft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: schedule.id,
        bookingCreditScheduleKey: options.bookingCreditScheduleKey ?? null,
        autoAssignable: options.autoAssignable ?? true,
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
    return { planKey, version: published.version, id: published.id };
  }

  /**
   * The ONE auto-assignable base plan a test may have.
   *
   * `ex_plan_versions_single_auto_assignable` permits exactly one active
   * auto-assignable version, which is the constraint that makes `D-7` singular.
   * So the base workspace is created once per test and every seller lands on
   * it; a seller who needs a specific credit binding is then MOVED by a real
   * plan selection, which is the production path an administrator's new plan
   * would take anyway.
   */
  let baseWorkspace: { planKey: string; version: number; id: string } | null = null;
  async function ensureBaseWorkspace(): Promise<void> {
    if (!baseWorkspace) {
      baseWorkspace = await publishedPlan({ bookingCreditScheduleKey: null, autoAssignable: true });
    }
  }

  /** A professional owner with an active subscription, optionally bound to a credit schedule. */
  async function seller(
    options: { bookingCreditScheduleKey?: string | null; roles?: string[] } = {},
  ): Promise<{ user: SeededUser; partyId: string; workspaceRef: string; subscriptionId: string }> {
    await ensureBaseWorkspace();

    const user = await seedUser(app, dataSource, nextPhone(), options.roles ?? ['professional']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص خرید');
    const party = { partyType: 'professional' as const, partyId: professional.id };
    let subscription = await subscriptions.ensureBaseSubscription(party);

    if (options.bookingCreditScheduleKey) {
      // A real, published, NON-auto-assignable plan carrying the binding, and a
      // real selection onto it — so the snapshot this suite then asserts was
      // written by the production activation path rather than by a fixture.
      const bound = await publishedPlan({
        bookingCreditScheduleKey: options.bookingCreditScheduleKey,
        autoAssignable: false,
      });
      subscription = await subscriptions.selectPlanVersion(party, bound.planKey, bound.version, user.id);
    }

    return {
      user,
      partyId: professional.id,
      workspaceRef: references.referenceFor(user.id, party),
      subscriptionId: subscription.id,
    };
  }

  // ------------------------------------------------------------------ HTTP

  const post = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).post(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };
  const get = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };

  const quote = (user: SeededUser, ref: string, body: unknown) =>
    post(`/me/subscriptions/${ref}/credit-purchases/quote`, user).send(body as object);

  const buy = (user: SeededUser, ref: string, body: unknown, key = 'idem-key-0001') =>
    post(`/me/subscriptions/${ref}/credit-purchases`, user).set('Idempotency-Key', key).send(body as object);

  const listPurchases = (user: SeededUser, ref: string, query = '') =>
    get(`/me/subscriptions/${ref}/credit-purchases${query}`, user);

  const purchaseRows = async (subscriptionId?: string) =>
    subscriptionId
      ? dataSource.query('SELECT * FROM commercial.credit_purchases WHERE subscription_id = $1', [subscriptionId])
      : dataSource.query('SELECT * FROM commercial.credit_purchases');

  const purchaseAudit = async (subscriptionId: string) =>
    dataSource.query(
      `SELECT action, actor_user_id, actor_label, reason, after_state
         FROM admin.admin_audit_log
        WHERE action = 'commercial.credit_purchase_requested' AND target_id = $1
        ORDER BY id`,
      [subscriptionId],
    );

  // =========================================================================
  // 1. Pricing — exact integers, real tiers, real boundaries
  // =========================================================================

  describe('pricing', () => {
    it('prices every tier boundary exactly, with no floating point anywhere', async () => {
      const schedule = await creditSchedule({
        min: 1,
        max: 1000,
        tiers: [
          { minQuantity: 1, maxQuantity: 9, unitPriceToman: 1_000 },
          { minQuantity: 10, maxQuantity: 99, unitPriceToman: 900 },
          { minQuantity: 100, maxQuantity: null, unitPriceToman: 800 },
        ],
      });
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      // Both sides of every boundary, so an off-by-one in tier selection fails.
      const expectations: Array<[number, number, number]> = [
        [1, 1_000, 1_000],
        [9, 1_000, 9_000],
        [10, 900, 9_000],
        [99, 900, 89_100],
        [100, 800, 80_000],
        [1000, 800, 800_000],
      ];

      for (const [quantity, unitPriceToman, totalToman] of expectations) {
        const response = await quote(s.user, s.workspaceRef, { quantity });
        expect(response.status).toBe(201);
        expect(response.body.data).toEqual({ quantity, unitPriceToman, totalToman, currency: 'IRT' });
        expect(Number.isInteger(response.body.data.totalToman)).toBe(true);
      }
    });

    it('prices a flat one-tier schedule, and a zero-price one', async () => {
      const flat = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 7 }] });
      const a = await seller({ bookingCreditScheduleKey: flat.key });
      expect((await quote(a.user, a.workspaceRef, { quantity: 1_000 })).body.data).toEqual({
        quantity: 1_000,
        unitPriceToman: 7,
        totalToman: 7_000,
        currency: 'IRT',
      });

      // Zero is a real price, not a missing one. `V33-DEC-009`.
      const free = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 0 }] });
      const b = await seller({ bookingCreditScheduleKey: free.key });
      expect((await quote(b.user, b.workspaceRef, { quantity: 5 })).body.data.totalToman).toBe(0);
    });

    it('carries a large total exactly, past the float-safe boundary', async () => {
      // 1e9 × 9007 = 9.007e12 — above 2^53 ≈ 9.007e15 / 1000, and well inside
      // the money bound. Computed with BigInt in the contract and stored in a
      // `bigint` column; a float anywhere on this path loses the last digits.
      const schedule = await creditSchedule({
        min: 1,
        max: 1_000_000_000,
        tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 9_007 }],
      });
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      const response = await quote(s.user, s.workspaceRef, { quantity: 1_000_000_000 });
      expect(response.status).toBe(201);
      expect(response.body.data.totalToman).toBe(9_007_000_000_000);

      const created = await buy(s.user, s.workspaceRef, { quantity: 1_000_000_000 });
      expect(created.status).toBe(201);
      const [row] = await purchaseRows(s.subscriptionId);
      // Read back from PostgreSQL as a string and parsed, so a silent rounding
      // in the transformer fails here rather than in production.
      expect(Number(row.total_toman)).toBe(9_007_000_000_000);
    });

    it('refuses zero, negative, fractional and non-numeric quantities', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      // `true` is in this list deliberately: `Number(true)` is `1`, so a DTO
      // that coerced would have bought one credit nobody asked for. `'7'` is
      // here for the same reason — a numeric field takes a JSON number.
      for (const quantity of [0, -1, 1.5, 'abc', '7', null, true, {}]) {
        const response = await quote(s.user, s.workspaceRef, { quantity });
        expect(response.status).toBe(400);
      }

      // The control: the same route, the same seller, one valid quantity.
      expect((await quote(s.user, s.workspaceRef, { quantity: 1 })).status).toBe(201);
    });

    it('refuses a quantity beyond the technical bound before it can overflow', async () => {
      const schedule = await creditSchedule({ min: 1, max: 1_000_000_000 });
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      // One past `MAX_PURCHASABLE_QUANTITY`. A DTO refusal, so it never reaches
      // a multiplication.
      expect((await quote(s.user, s.workspaceRef, { quantity: 1_000_000_001 })).status).toBe(400);
      expect((await quote(s.user, s.workspaceRef, { quantity: 1_000_000_000 })).status).toBe(201);
    });
  });

  // =========================================================================
  // 2. Every failure is the same failure
  // =========================================================================

  describe('the one public refusal', () => {
    /**
     * The whole point of `V33-DEC-026` R8: a caller cannot tell these apart, so
     * the administrator's catalogue cannot be enumerated one refusal at a time.
     */
    it('collapses seven different causes into one identical response body', async () => {
      const bodies: unknown[] = [];
      const statuses: number[] = [];

      const record = async (s: { user: SeededUser; workspaceRef: string }, quantity = 5) => {
        const response = await quote(s.user, s.workspaceRef, { quantity });
        statuses.push(response.status);
        bodies.push(response.body);
      };

      // Seven causes a real deployment can actually be in. Rewriting a
      // subscription snapshot to manufacture one is not available and should
      // not be: `tg_seller_subscriptions_immutable` refuses it, which is
      // itself asserted in `the plan-to-schedule binding` above.

      // (1) no binding at all — every plan version that exists today
      await record(await seller({ bookingCreditScheduleKey: null }));

      // (2) a schedule whose only version is still a DRAFT
      const unpublished = await creditSchedule({ publish: false });
      await record(await seller({ bookingCreditScheduleKey: unpublished.key }));

      // (3) a published version whose activation window has not opened
      const future = await creditSchedule({ activationStartsAt: new Date('2999-01-01T00:00:00.000Z') });
      await record(await seller({ bookingCreditScheduleKey: future.key }));

      // (4) a published version whose window has closed
      const past = await creditSchedule({
        activationStartsAt: new Date('2000-01-01T00:00:00.000Z'),
        activationEndsAt: new Date('2001-01-01T00:00:00.000Z'),
      });
      await record(await seller({ bookingCreditScheduleKey: past.key }));

      // (5) a version that was RETIRED after publication
      const retiredKey = nextKey('retired');
      const retired = await creditSchedule({ key: retiredKey });
      const retiredSeller = await seller({ bookingCreditScheduleKey: retiredKey });
      await catalogue.retireScheduleVersion(admin.id, retiredKey, retired.version, 'suite setup');
      await record(retiredSeller);

      // (6) a quantity BELOW the schedule's own commercial minimum
      // The tier set must cover the schedule's own bounds, so a bounded
      // schedule needs a tier that starts where the bound does.
      const bounded = await creditSchedule({
        min: 10,
        max: 20,
        tiers: [{ minQuantity: 10, maxQuantity: 20, unitPriceToman: 50 }],
      });
      const boundedSeller = await seller({ bookingCreditScheduleKey: bounded.key });
      await record(boundedSeller, 5);

      // (7) …and one ABOVE its maximum. Same schedule, same seller, so the
      //     two differ only in the quantity.
      await record(boundedSeller, 5_000);
      expect(statuses).toEqual([409, 409, 409, 409, 409, 409, 409]);
      // Whole bodies, byte-identical. Not a code spot-check.
      const [first] = bodies;
      for (const body of bodies) expect(body).toEqual(first);
      expect((first as { error: { code: string } }).error.code).toBe('purchase_unavailable');

      // The control: a configured seller, same route, gets a price. Without
      // this every assertion above would pass against a server that refused
      // everything.
      const working = await creditSchedule();
      const ok = await seller({ bookingCreditScheduleKey: working.key });
      const success = await quote(ok.user, ok.workspaceRef, { quantity: 5 });
      expect(success.status).toBe(201);
      expect(success.body).not.toEqual(first);
    });

    it('the seeded catalogue is unavailable, and that is the shipped state', async () => {
      // No `resetDatabase` truncation games: re-publish the seeded shape — a
      // plan version with NO credit binding, which is what `D-7` is — and show
      // the surface refuses. `V33-DEC-027` R8: nothing is backfilled.
      const s = await seller({ bookingCreditScheduleKey: null });
      expect((await quote(s.user, s.workspaceRef, { quantity: 1 })).status).toBe(409);
      expect((await buy(s.user, s.workspaceRef, { quantity: 1 })).status).toBe(409);
      expect(await purchaseRows()).toHaveLength(0);
    });

    it('the real seeded D-7 carries no binding and no booking-credit schedule exists', async () => {
      // Read the migration itself: `resetDatabase` truncates the seed away, so
      // the live table cannot answer this. The migration is the artefact that
      // ships.
      const migration = readFileSync(
        join(__dirname, '..', '..', '..', 'database', 'migrations', 'commercial', '20260906900001_create_credit_purchases.sql'),
        'utf8',
      );
      // It seeds no schedule of any kind.
      expect(migration).not.toMatch(/INSERT INTO commercial\.price_schedules/);
      expect(migration).not.toMatch(/INSERT INTO commercial\.price_schedule_versions/);
      expect(migration).not.toMatch(/INSERT INTO commercial\.plan_versions/);
      // The one `UPDATE ... SET booking_credit_schedule_key` in the file is
      // inside the prove block, where it is EXPECTED TO FAIL — the assertion
      // that a `seller_plan` target is unwritable.
      const proveBlock = migration.slice(migration.indexOf('DO $prove$'));
      expect(migration.match(/SET booking_credit_schedule_key/g) ?? []).toHaveLength(1);
      expect(proveBlock).toContain('SET booking_credit_schedule_key');
      expect(proveBlock).toContain('a seller_plan schedule was accepted as a booking-credit binding');
      // And the block asserts both absences on the live database at migration
      // time; this asserts the block is still there to do it.
      expect(proveBlock).toContain('this migration seeds none');
      expect(proveBlock).toContain('this migration backfills none');
    });
  });

  // =========================================================================
  // 3. The binding — per plan, database-enforced, snapshotted
  // =========================================================================

  describe('the plan-to-schedule binding', () => {
    it('two plans bound to different schedules each resolve their own', async () => {
      const cheap = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 10 }] });
      const dear = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 90 }] });

      const a = await seller({ bookingCreditScheduleKey: cheap.key });
      const b = await seller({ bookingCreditScheduleKey: dear.key });

      expect((await quote(a.user, a.workspaceRef, { quantity: 3 })).body.data.totalToman).toBe(30);
      expect((await quote(b.user, b.workspaceRef, { quantity: 3 })).body.data.totalToman).toBe(270);
    });

    it('two plans sharing one key both work', async () => {
      const shared = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 11 }] });
      const a = await seller({ bookingCreditScheduleKey: shared.key });
      const b = await seller({ bookingCreditScheduleKey: shared.key });

      expect((await quote(a.user, a.workspaceRef, { quantity: 2 })).body.data.totalToman).toBe(22);
      expect((await quote(b.user, b.workspaceRef, { quantity: 2 })).body.data.totalToman).toBe(22);
    });

    it('raw SQL cannot bind a plan version to a seller_plan schedule', async () => {
      const planSchedule = nextKey('sellerplan');
      await catalogue.createPriceSchedule(admin.id, planSchedule, 'seller_plan', 'suite setup');
      const credits = await creditSchedule();
      const plan = await publishedPlan({ bookingCreditScheduleKey: null });
      const [version] = await dataSource.query(
        'SELECT id FROM commercial.plan_versions WHERE plan_key = $1 LIMIT 1',
        [plan.planKey],
      );

      // The guarantee: a wrong-purpose target is UNWRITABLE, not merely
      // rejected by whichever code path constructed it.
      await expect(
        dataSource.query('UPDATE commercial.plan_versions SET booking_credit_schedule_key = $2 WHERE id = $1', [
          version.id,
          planSchedule,
        ]),
      ).rejects.toThrow(/fk_plan_versions_booking_credit_schedule|violates foreign key|immutable/);

      // The control: the SAME statement with a booking_credit key is refused
      // only by the published-immutability rule, proving the composite FK is
      // what stopped the first one rather than a blanket refusal of the column.
      await expect(
        dataSource.query('UPDATE commercial.plan_versions SET booking_credit_schedule_key = $2 WHERE id = $1', [
          version.id,
          credits.key,
        ]),
      ).rejects.toThrow(/immutable/);
    });

    it('a draft accepts a booking_credit key and refuses a seller_plan one', async () => {
      const credits = await creditSchedule();
      const planSchedule = nextKey('sellerplan2');
      await catalogue.createPriceSchedule(admin.id, planSchedule, 'seller_plan', 'suite setup');

      const planKey = nextKey('draftplan');
      await catalogue.createPlan(admin.id, planKey, 'suite setup');
      const [anySchedule] = await dataSource.query(
        "SELECT id FROM commercial.price_schedule_versions WHERE lifecycle_state = 'published' LIMIT 1",
      );

      const draftInput = {
        planKey,
        priceScheduleVersionId: anySchedule.id,
        autoAssignable: false,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          displayName: planKey,
          billingTermDays: null,
          includedBookingCredits: 0,
          staffSeats: 0,
          includedLocations: 0,
          capabilityKeys: [] as string[],
        },
      };

      // Accepted.
      const draft = await catalogue.createPlanVersionDraft(
        admin.id,
        { ...draftInput, bookingCreditScheduleKey: credits.key },
        'suite setup',
      );
      const [written] = await dataSource.query(
        'SELECT booking_credit_schedule_key FROM commercial.plan_versions WHERE id = $1',
        [draft.id],
      );
      expect(written.booking_credit_schedule_key).toBe(credits.key);

      // Refused, by the database.
      await expect(
        catalogue.createPlanVersionDraft(
          admin.id,
          { ...draftInput, planKey, bookingCreditScheduleKey: planSchedule },
          'suite setup',
        ),
      ).rejects.toThrow();
    });

    it('a subscription snapshots the key, and a later plan change cannot redirect it', async () => {
      const original = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 5 }] });
      const s = await seller({ bookingCreditScheduleKey: original.key });

      const [snapshot] = await dataSource.query(
        'SELECT snapshot_booking_credit_schedule_key FROM commercial.seller_subscriptions WHERE id = $1',
        [s.subscriptionId],
      );
      expect(snapshot.snapshot_booking_credit_schedule_key).toBe(original.key);

      // The subscription's snapshot is immutable, by trigger.
      const other = await creditSchedule();
      await expect(
        dataSource.query(
          'UPDATE commercial.seller_subscriptions SET snapshot_booking_credit_schedule_key = $2 WHERE id = $1',
          [s.subscriptionId, other.key],
        ),
      ).rejects.toThrow(/immutable/);

      // And the price is still the original schedule's.
      expect((await quote(s.user, s.workspaceRef, { quantity: 4 })).body.data.totalToman).toBe(20);
    });

    it('an unbound seller keeps NULL, distinguishably from an empty string', async () => {
      const s = await seller({ bookingCreditScheduleKey: null });
      const [row] = await dataSource.query(
        'SELECT snapshot_booking_credit_schedule_key IS NULL AS is_null FROM commercial.seller_subscriptions WHERE id = $1',
        [s.subscriptionId],
      );
      expect(row.is_null).toBe(true);
    });
  });

  // =========================================================================
  // 4. The snapshot — written once, and never again
  // =========================================================================

  describe('the immutable snapshot', () => {
    it('records the exact schedule, version, tier and money in one row', async () => {
      const schedule = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 250 }] });
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      const before = Date.now();
      const created = await buy(s.user, s.workspaceRef, { quantity: 4 });
      expect(created.status).toBe(201);

      const [row] = await purchaseRows(s.subscriptionId);
      expect(row.subscription_id).toBe(s.subscriptionId);
      expect(row.subscriber_party_type).toBe('professional');
      expect(row.subscriber_party_id).toBe(s.partyId);
      expect(row.quantity).toBe(4);
      expect(row.schedule_key).toBe(schedule.key);
      expect(row.price_schedule_version_id).toBe(schedule.versionId);
      expect(Number(row.unit_price_toman)).toBe(250);
      expect(Number(row.total_toman)).toBe(1_000);
      expect(row.currency_code).toBe('IRT');
      expect(row.lifecycle_state).toBe('awaiting_payment');
      expect(row.requested_by_user_id).toBe(s.user.id);
      expect(new Date(row.effective_at).getTime()).toBeGreaterThanOrEqual(before - 1_000);

      // The tier really belongs to that version — the composite FK's claim,
      // read back rather than assumed.
      const [tier] = await dataSource.query(
        'SELECT schedule_version_id FROM commercial.price_tiers WHERE id = $1',
        [row.price_tier_id],
      );
      expect(tier.schedule_version_id).toBe(schedule.versionId);
    });

    it('refuses UPDATE of every snapshot column and DELETE outright', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      await buy(s.user, s.workspaceRef, { quantity: 3 });
      const [row] = await purchaseRows(s.subscriptionId);

      for (const [column, value] of [
        ['quantity', 99],
        ['unit_price_toman', 1],
        ['total_toman', 1],
        ['schedule_key', 'other'],
        // A DIFFERENT id: setting a column to the value it already has is not
        // `IS DISTINCT FROM` and would pass without proving anything.
        ['subscriber_party_id', '00000000-0000-4000-8000-0000000000dd'],
      ] as Array<[string, unknown]>) {
        await expect(
          dataSource.query(`UPDATE commercial.credit_purchases SET ${column} = $2 WHERE id = $1`, [row.id, value]),
        ).rejects.toThrow(/immutable|violates|invalid/);
      }

      await expect(
        dataSource.query('DELETE FROM commercial.credit_purchases WHERE id = $1', [row.id]),
      ).rejects.toThrow(/immutable/);

      // The one permitted transition, so the case above is about the SNAPSHOT
      // and not a blanket refusal of every UPDATE.
      await dataSource.query(
        "UPDATE commercial.credit_purchases SET lifecycle_state = 'abandoned' WHERE id = $1",
        [row.id],
      );
      const [after] = await purchaseRows(s.subscriptionId);
      expect(after.lifecycle_state).toBe('abandoned');

      // And nothing leaves `abandoned`, nor reaches a state #99 has not added.
      await expect(
        dataSource.query("UPDATE commercial.credit_purchases SET lifecycle_state = 'paid' WHERE id = $1", [row.id]),
      ).rejects.toThrow(/immutable|violates check|not permitted/);
    });

    it('PostgreSQL refuses a wrong total, currency, lifecycle, party or tier', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      await buy(s.user, s.workspaceRef, { quantity: 2 });
      const [good] = await purchaseRows(s.subscriptionId);

      const insert = (overrides: Record<string, unknown>) => {
        const row = {
          id: '00000000-0000-4000-8000-0000000000aa',
          subscription_id: good.subscription_id,
          subscriber_party_type: good.subscriber_party_type,
          subscriber_party_id: good.subscriber_party_id,
          quantity: good.quantity,
          schedule_key: good.schedule_key,
          price_schedule_version_id: good.price_schedule_version_id,
          price_tier_id: good.price_tier_id,
          unit_price_toman: good.unit_price_toman,
          total_toman: good.total_toman,
          currency_code: 'IRT',
          effective_at: good.effective_at,
          lifecycle_state: 'awaiting_payment',
          request_key: 'raw-sql-attempt-0001',
          requested_by_user_id: good.requested_by_user_id,
          ...overrides,
        };
        const columns = Object.keys(row);
        const params = columns.map((_, index) => `$${index + 1}`).join(', ');
        return dataSource.query(
          `INSERT INTO commercial.credit_purchases (${columns.join(', ')}) VALUES (${params})`,
          Object.values(row),
        );
      };

      // The total must equal unit × quantity.
      await expect(insert({ total_toman: Number(good.total_toman) + 1 })).rejects.toThrow(/ck_credit_purchases_total/);
      // IRT only.
      await expect(insert({ currency_code: 'USD' })).rejects.toThrow(/ck_credit_purchases_currency/);
      // A lifecycle #99 has not added.
      await expect(insert({ lifecycle_state: 'paid' })).rejects.toThrow(/ck_credit_purchases_lifecycle/);
      // A party the subscription does not have.
      await expect(insert({ subscriber_party_id: '00000000-0000-4000-8000-0000000000bb' })).rejects.toThrow(
        /fk_credit_purchases_subscription_party|violates foreign key/,
      );
      // A version that does not belong to the key.
      const other = await creditSchedule();
      await expect(insert({ price_schedule_version_id: other.versionId })).rejects.toThrow(
        /fk_credit_purchases_schedule_version|violates foreign key/,
      );
      // A tier that does not belong to the version.
      const [otherTier] = await dataSource.query(
        'SELECT id FROM commercial.price_tiers WHERE schedule_version_id = $1 LIMIT 1',
        [other.versionId],
      );
      await expect(insert({ price_tier_id: otherTier.id })).rejects.toThrow(
        /fk_credit_purchases_tier|violates foreign key/,
      );
      // Zero and negative quantities.
      await expect(insert({ quantity: 0, total_toman: 0 })).rejects.toThrow(/ck_credit_purchases_quantity/);

      // The control: the same builder with no overrides succeeds, so every
      // refusal above is attributable to its override.
      await expect(insert({})).resolves.toBeDefined();
    });

    it('a repricing changes later purchases and leaves earlier ones byte-identical', async () => {
      /*
       * Two ADJACENT windows on one key, not an edit.
       *
       * A published schedule version is immutable — `enforce_schedule_version_lifecycle`
       * refuses a changed `activation_ends_at`, which the catalogue's own suite
       * asserts — so repricing is publishing a second version whose window
       * starts where the first one ends. `ex_price_schedule_versions_no_overlap`
       * accepts adjacent half-open ranges and would refuse an overlap, so this
       * is the only shape an administrator has.
       */
      const key = nextKey('reprice');
      const boundary = new Date(Date.now() + 2_500);

      await creditSchedule({
        key,
        tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 100 }],
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: boundary,
      });
      await creditSchedule({
        key,
        tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 300 }],
        activationStartsAt: boundary,
        activationEndsAt: null,
      });

      const s = await seller({ bookingCreditScheduleKey: key });

      const first = await buy(s.user, s.workspaceRef, { quantity: 2 }, 'before-reprice-01');
      expect(first.status).toBe(201);
      expect(first.body.data.totalToman).toBe(200);
      const [beforeRow] = await purchaseRows(s.subscriptionId);

      // Cross the boundary. Nothing is migrated and no subscription moves;
      // the SECOND version simply becomes the active one for this key.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const second = await buy(s.user, s.workspaceRef, { quantity: 2 }, 'after-reprice-01');
      expect(second.status).toBe(201);
      expect(second.body.data.totalToman).toBe(600);

      const rows = await purchaseRows(s.subscriptionId);
      expect(rows).toHaveLength(2);
      // Byte-identical: the earlier row is exactly what it was.
      expect(rows.find((row: { id: string }) => row.id === beforeRow.id)).toEqual(beforeRow);
      // Two different versions of ONE key.
      expect(new Set(rows.map((r: { price_schedule_version_id: string }) => r.price_schedule_version_id)).size).toBe(2);
      expect(new Set(rows.map((r: { schedule_key: string }) => r.schedule_key)).size).toBe(1);

      const [subscription] = await dataSource.query(
        'SELECT snapshot_booking_credit_schedule_key FROM commercial.seller_subscriptions WHERE id = $1',
        [s.subscriptionId],
      );
      expect(subscription.snapshot_booking_credit_schedule_key).toBe(key);
    });

  });

  // =========================================================================
  // 5. Idempotency, concurrency and rollback
  // =========================================================================

  describe('idempotency and concurrency', () => {
    it('N concurrent creates with one key yield one row, one audit and identical bodies', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => buy(s.user, s.workspaceRef, { quantity: 6 }, 'race-key-000001')),
      );

      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const [first] = responses;
      for (const response of responses) expect(response.body).toEqual(first.body);

      expect(await purchaseRows(s.subscriptionId)).toHaveLength(1);
      expect(await purchaseAudit(s.subscriptionId)).toHaveLength(1);
    });

    it('different keys create different rows', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      await buy(s.user, s.workspaceRef, { quantity: 1 }, 'key-aaaa-0001');
      await buy(s.user, s.workspaceRef, { quantity: 2 }, 'key-bbbb-0002');

      const rows = await purchaseRows(s.subscriptionId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r: { quantity: number }) => r.quantity).sort()).toEqual([1, 2]);
      expect(await purchaseAudit(s.subscriptionId)).toHaveLength(2);
    });

    it('a missing or too-short Idempotency-Key is refused', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      expect(
        (await post(`/me/subscriptions/${s.workspaceRef}/credit-purchases`, s.user).send({ quantity: 1 })).status,
      ).toBe(400);
      expect((await buy(s.user, s.workspaceRef, { quantity: 1 }, 'short')).status).toBe(400);
      expect((await buy(s.user, s.workspaceRef, { quantity: 1 }, 'long-enough-key')).status).toBe(201);
      expect(await purchaseRows(s.subscriptionId)).toHaveLength(1);
    });

    it('a rolled-back transaction leaves neither purchase nor audit', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO commercial.credit_purchases
               (id, subscription_id, subscriber_party_type, subscriber_party_id, quantity, schedule_key,
                price_schedule_version_id, price_tier_id, unit_price_toman, total_toman, currency_code,
                effective_at, lifecycle_state, request_key, requested_by_user_id)
             SELECT '00000000-0000-4000-8000-0000000000cc', $1, 'professional', $2, 1, $3, v.id, t.id, t.unit_price_toman,
                    t.unit_price_toman, 'IRT', now(), 'awaiting_payment', 'rollback-key-0001', $4
               FROM commercial.price_schedule_versions v
               JOIN commercial.price_tiers t ON t.schedule_version_id = v.id
              WHERE v.id = $5 LIMIT 1`,
            [s.subscriptionId, s.partyId, schedule.key, s.user.id, schedule.versionId],
          );
          const [{ n }] = await manager.query(
            'SELECT count(*)::int AS n FROM commercial.credit_purchases WHERE subscription_id = $1',
            [s.subscriptionId],
          );
          expect(n).toBe(1);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(await purchaseRows(s.subscriptionId)).toHaveLength(0);
      expect(await purchaseAudit(s.subscriptionId)).toHaveLength(0);
    });
  });

  // =========================================================================
  // 6. Authorization and the request surface
  // =========================================================================

  describe('ownership and the request contract', () => {
    it('refuses malformed, foreign, stale and nonexistent references byte-identically', async () => {
      const schedule = await creditSchedule();
      const mine = await seller({ bookingCreditScheduleKey: schedule.key });
      const theirs = await seller({ bookingCreditScheduleKey: schedule.key });

      const refs = [
        'not-a-reference',
        'A'.repeat(43),
        theirs.workspaceRef,
        references.referenceFor(mine.user.id, { partyType: 'business', partyId: mine.partyId }),
      ];

      const bodies: unknown[] = [];
      for (const ref of refs) {
        const response = await quote(mine.user, ref, { quantity: 1 });
        expect(response.status).toBe(404);
        bodies.push(response.body);
      }
      const [first] = bodies;
      for (const body of bodies) expect(body).toEqual(first);

      // The control: the caller's OWN reference works on the same route.
      expect((await quote(mine.user, mine.workspaceRef, { quantity: 1 })).status).toBe(201);
    });

    it('a staff member gets nothing, and their employer is untouched', async () => {
      const schedule = await creditSchedule();
      await publishedPlan({ bookingCreditScheduleKey: schedule.key });
      const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'کسب‌وکار کارفرما');
      const party = { partyType: 'business' as const, partyId: business.id };
      await subscriptions.ensureBaseSubscription(party);
      const employerRef = references.referenceFor(owner.id, party);

      const staff = await seedUser(app, dataSource, nextPhone(), ['professional']);
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
         VALUES (gen_random_uuid(), $1, $2, 'receptionist', 'active', $3)`,
        [business.id, staff.id, owner.id],
      );

      // Staff affiliation is not authority — `V33-DEC-020`, restated by
      // `V33-DEC-026` R6.
      expect((await quote(staff, employerRef, { quantity: 1 })).status).toBe(404);
      expect((await buy(staff, employerRef, { quantity: 1 })).status).toBe(404);
      expect((await listPurchases(staff, employerRef)).status).toBe(404);
      expect(await purchaseRows()).toHaveLength(0);
    });

    it('rejects every forged field with a 400 rather than ignoring it', async () => {
      const schedule = await creditSchedule({ tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 40 }] });
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      const forged = [
        { quantity: 1, totalToman: 0 },
        { quantity: 1, unitPriceToman: 0 },
        { quantity: 1, currency: 'USD' },
        { quantity: 1, scheduleKey: 'other' },
        { quantity: 1, scheduleVersionId: schedule.versionId },
        { quantity: 1, tierId: 'x' },
        { quantity: 1, subscriptionId: s.subscriptionId },
        { quantity: 1, partyId: s.partyId },
        { quantity: 1, professionalId: s.partyId },
        { quantity: 1, ownerId: s.user.id },
        { quantity: 1, userId: s.user.id },
        { quantity: 1, state: 'abandoned' },
        { quantity: 1, lifecycleState: 'abandoned' },
        { quantity: 1, reason: 'because' },
      ];

      for (const body of forged) {
        expect((await quote(s.user, s.workspaceRef, body)).status).toBe(400);
        expect((await buy(s.user, s.workspaceRef, body)).status).toBe(400);
      }

      // Nothing was written by any of them, and the honest body still works at
      // the price the CATALOGUE says.
      expect(await purchaseRows(s.subscriptionId)).toHaveLength(0);
      const ok = await buy(s.user, s.workspaceRef, { quantity: 1 });
      expect(ok.status).toBe(201);
      expect(ok.body.data.totalToman).toBe(40);
    });

    it('rejects an unknown query parameter on the list', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      expect((await listPurchases(s.user, s.workspaceRef, '?limit=1000')).status).toBe(400);
      expect((await listPurchases(s.user, s.workspaceRef)).status).toBe(200);
    });

    it('an unauthenticated caller reaches nothing', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      expect((await post(`/me/subscriptions/${s.workspaceRef}/credit-purchases/quote`).send({ quantity: 1 })).status).toBe(401);
      expect((await get(`/me/subscriptions/${s.workspaceRef}/credit-purchases`)).status).toBe(401);
    });
  });

  // =========================================================================
  // 7. The list
  // =========================================================================

  describe('the list', () => {
    it('returns the seller their own purchases, newest first, and no one else', async () => {
      const schedule = await creditSchedule();
      const mine = await seller({ bookingCreditScheduleKey: schedule.key });
      const theirs = await seller({ bookingCreditScheduleKey: schedule.key });

      await buy(mine.user, mine.workspaceRef, { quantity: 1 }, 'mine-key-0001');
      await buy(mine.user, mine.workspaceRef, { quantity: 2 }, 'mine-key-0002');
      await buy(theirs.user, theirs.workspaceRef, { quantity: 9 }, 'their-key-0001');

      const response = await listPurchases(mine.user, mine.workspaceRef);
      expect(response.status).toBe(200);
      expect(response.body.data.items.map((item: { quantity: number }) => item.quantity)).toEqual([2, 1]);
      expect(JSON.stringify(response.body)).not.toContain('mine-key-0001');
      expect(JSON.stringify(response.body)).not.toContain(mine.user.id);
      expect(JSON.stringify(response.body)).not.toContain(schedule.key);
    });

    it('a cursor stolen from another workspace widens nothing', async () => {
      const schedule = await creditSchedule();
      const mine = await seller({ bookingCreditScheduleKey: schedule.key });
      const theirs = await seller({ bookingCreditScheduleKey: schedule.key });

      await buy(theirs.user, theirs.workspaceRef, { quantity: 9 }, 'their-key-0002');
      const [theirRow] = await purchaseRows(theirs.subscriptionId);
      const stolen = Buffer.from(`${new Date(theirRow.created_at).toISOString()}|${theirRow.id}`, 'utf8').toString(
        'base64url',
      );

      await buy(mine.user, mine.workspaceRef, { quantity: 1 }, 'mine-key-0003');
      const response = await listPurchases(mine.user, mine.workspaceRef, `?cursor=${stolen}`);
      expect(response.status).toBe(200);
      for (const item of response.body.data.items) expect(item.quantity).not.toBe(9);
    });

    it('bounds the page, and the query count does not grow with the history', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      for (let i = 0; i < 3; i += 1) {
        await buy(s.user, s.workspaceRef, { quantity: i + 1 }, `page-key-${1000 + i}`);
      }
      const response = await listPurchases(s.user, s.workspaceRef);
      expect(response.body.data.items.length).toBe(3);
      expect(response.body.data.items.length).toBeLessThanOrEqual(50);
    });
  });

  // =========================================================================
  // 8. Audit and privacy
  // =========================================================================

  describe('audit and privacy', () => {
    it('writes one closed audit row per real purchase and none for a replay', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });

      await buy(s.user, s.workspaceRef, { quantity: 3 }, 'audit-key-0001');
      await buy(s.user, s.workspaceRef, { quantity: 3 }, 'audit-key-0001');

      const rows = await purchaseAudit(s.subscriptionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBeNull();
      expect(rows[0].actor_label).toBe('system');
      expect(rows[0].reason).toBe(
        'seller requested a custom booking-credit quantity at the price then published',
      );
      // No caller prose and no protocol token in the record.
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('audit-key-0001');
      expect(serialized).not.toContain(s.user.id);
    });

    it('claims the table as retained and exports only the seller their own facts', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const contract = contracts.find((c) => c.moduleKey === 'commercial-subscription');
      expect(
        (contract?.tables ?? []).filter((c) => c.table === 'commercial.credit_purchases').map((c) => c.disposition),
      ).toEqual(['retained']);

      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      await buy(s.user, s.workspaceRef, { quantity: 2 }, 'export-key-0001');

      const sections = await dataSource.transaction((manager) => contract!.exportSubjectData(manager, s.user.id));
      const purchases = sections.find((section) => section.key === 'commercial.credit_purchases');
      expect(purchases?.rows).toHaveLength(1);
      const serialized = JSON.stringify(purchases);
      expect(serialized).not.toContain('export-key-0001');
      expect(serialized).not.toContain(schedule.key);
      expect(serialized).not.toContain(s.user.id);

      // Erasure deletes and anonymizes nothing, and says so.
      const outcome = await dataSource.transaction((manager) =>
        contract!.eraseSubjectData(manager, s.user.id, {
          userId: s.user.id,
          phoneAlias: `erased-${s.user.id.slice(0, 8)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date(),
        }),
      );
      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((r) => r.table)).toContain('commercial.credit_purchases');
      expect(await purchaseRows(s.subscriptionId)).toHaveLength(1);
    });
  });

  // =========================================================================
  // 9. Structural absence — each with a non-vacuous control
  // =========================================================================

  describe('what this story does not create', () => {
    it('writes no booking-credit grant and does not widen the source vocabulary', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      const before = await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_grants');

      await buy(s.user, s.workspaceRef, { quantity: 100 }, 'grant-key-0001');

      const after = await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_grants');
      expect(after[0].n).toBe(before[0].n);

      const [constraint] = await dataSource.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_booking_credit_grants_source'",
      );
      // Non-vacuity: the constraint really exists and really names the one
      // permitted source.
      expect(constraint.def).toContain('plan_included');
      expect(constraint.def).not.toContain('custom_purchase');

      // And the uniqueness #99 will replace is still #56a's.
      const [unique] = await dataSource.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'uq_booking_credit_grants_once'",
      );
      expect(unique.def).toContain('UNIQUE');
    });

    it('creates no order, payment intent, refund or ledger entry', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      await buy(s.user, s.workspaceRef, { quantity: 50 }, 'money-key-0001');

      const [counts] = await dataSource.query(
        `SELECT (SELECT count(*) FROM commerce.orders)::int AS orders,
                (SELECT count(*) FROM payment.payment_intents)::int AS intents,
                (SELECT count(*) FROM payment.refunds)::int AS refunds`,
      );
      expect(counts).toEqual({ orders: 0, intents: 0, refunds: 0 });

      // Non-vacuity: the purchase itself DID happen, so the zeros are about the
      // money tables rather than about nothing having run.
      expect(await purchaseRows(s.subscriptionId)).toHaveLength(1);
    });

    it('emits no event: the commercial domain still has no outbox', async () => {
      const schedule = await creditSchedule();
      const s = await seller({ bookingCreditScheduleKey: schedule.key });
      await buy(s.user, s.workspaceRef, { quantity: 1 }, 'event-key-0001');

      expect(
        await dataSource.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'commercial' AND tablename = 'outbox_events'",
        ),
      ).toEqual([]);

      const types: Array<{ event_type: string }> = await dataSource.query(
        'SELECT event_type FROM commerce.outbox_events UNION ALL SELECT event_type FROM booking.outbox_events',
      );
      expect(types.filter((r) => /Credit|Purchase|Entitlement/i.test(r.event_type))).toEqual([]);
    });

    it('adds exactly three routes, and no balance, grant or admin purchase route', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as { stack: Array<{ route?: { path: string } }> };
      const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route!.path);

      // Non-vacuity: the enumerator really sees this application's routes.
      expect(paths.length).toBeGreaterThan(20);
      expect(paths).toContain('/api/v1/me/subscriptions');

      expect(paths.filter((p) => p.includes('credit-purchases')).sort()).toEqual([
        '/api/v1/me/subscriptions/:workspaceRef/credit-purchases',
        '/api/v1/me/subscriptions/:workspaceRef/credit-purchases',
        '/api/v1/me/subscriptions/:workspaceRef/credit-purchases/quote',
      ]);
      expect(paths.filter((p) => /balance|grant|allowance/i.test(p))).toEqual([]);
    });

    it('resolves the price on the caller’s manager, not a fresh connection', () => {
      /*
       * A structural assertion, because the consequence is not observable from
       * outside: a price read on a second connection produces the same body
       * until an administrator publishes between the read and the write, and
       * staging that interleaving from a test would prove the staging rather
       * than the code.
       *
       * What IS checkable is the shape a mutation would have to break — the
       * same reasoning `#58a` used for its two call sites. `priceFor` must
       * thread the manager it was given, and must not reach for
       * `this.dataSource.manager`, which is a different pooled connection.
       */
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'services', 'commercial-policy', 'src', 'seller-surface', 'credit-purchase.service.ts'),
        'utf8',
      );
      const priceFor = source.slice(source.indexOf('  private async priceFor('));
      const body = priceFor.slice(0, priceFor.indexOf('  }'));

      // Non-vacuity: the method really was found and really resolves a price.
      expect(body).toContain('resolveBookingCreditWithin');
      expect(body).toContain('resolveBookingCreditWithin(manager,');
      expect(body).not.toContain('this.dataSource');

      // And the write path hands it the transaction's own manager.
      expect(source).toContain('this.priceFor(manager, subscription, quantity, effectiveAt)');
    });

    it('writes the audit on that same manager, so a rollback takes it too', () => {
      /*
       * `#58a` had to make this correction after auditing a ledger through a
       * logger whose lines survive a ROLLBACK. The same mistake here would
       * record a purchase that never happened, and it is invisible to a
       * counting test: a successful path writes exactly one row either way.
       *
       * So the shape is asserted. `recordSystem` must receive the
       * transaction's own manager, and the insert path must not reach for a
       * second connection.
       */
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'services', 'commercial-policy', 'src', 'seller-surface', 'credit-purchase.service.ts'),
        'utf8',
      );
      const insertOnce = source.slice(source.indexOf('  private async insertOnce('));

      // Non-vacuity: the method was found and really does audit.
      expect(insertOnce).toContain('this.audit.recordSystem(');
      expect(insertOnce).toContain('this.audit.recordSystem(manager, {');
      // …and never on a second connection. `insertOnce` legitimately opens
      // its transaction through `this.dataSource.transaction`, so the
      // assertion names the exact misuse rather than banning the field.
      expect(source).not.toContain('recordSystem(this.dataSource');
    });
    it('adds no capability and no ServiceName member', async () => {
      const capabilities: Array<{ slug: string }> = await dataSource.query(
        "SELECT slug FROM identity.capabilities WHERE slug LIKE '%credit%' OR slug LIKE '%purchase%'",
      );
      expect(capabilities).toEqual([]);
      // Non-vacuity: the capability the routes DO use exists.
      const [existing] = await dataSource.query(
        "SELECT slug FROM identity.capabilities WHERE slug = 'bc_manage_own_subscription'",
      );
      expect(existing.slug).toBe('bc_manage_own_subscription');

      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'libs', 'event-contracts', 'src', 'event-contract.ts'),
        'utf8',
      );
      const union = source.slice(source.indexOf('export type ServiceName'));
      const members = (union.slice(0, union.indexOf(';')).match(/'[a-z-]+'/g) ?? []).map((m) => m.slice(1, -1));
      expect(members).toContain('commerce');
      expect(members).not.toContain('commercial');
    });
  });
});
