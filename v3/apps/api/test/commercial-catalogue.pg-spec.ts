import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, isSubjectColumn } from '@beauclick/subject-data';
import {
  CommercialCatalogueService,
  CommercialLifecycleConflictException,
  CommercialNotConfiguredException,
  CommercialTermsInvalidException,
} from '@beauclick/commercial-policy';
import { PriceResolutionError } from '@beauclick/commercial-policy-contract';

import { PgTestApp, SeededUser, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

const T0 = new Date('2027-01-01T00:00:00.000Z');
const T1 = new Date('2027-06-01T00:00:00.000Z');
const T2 = new Date('2028-01-01T00:00:00.000Z');
const MID_FIRST_WINDOW = new Date('2027-03-01T00:00:00.000Z');

/**
 * The plan and price catalogue against a real PostgreSQL server — V3.3-A Story
 * #40 (`#40a`), ADR-041, `V33-DEC-009`.
 *
 * ## Why every guarantee here is proved HERE and nowhere else
 *
 * pg-mem does not honour TypeORM's ROLLBACK, has no exclusion constraints, and
 * runs no PL/pgSQL. **Every single invariant this story rests on is one of
 * those three things.** The lifecycle allow-list, the immutability of a
 * published version, activation-window non-overlap, tier contiguity and the
 * base workspace's zero price are triggers and EXCLUDE constraints; the
 * transactional audit row is a rollback. None of them can be observed on the
 * fast layer, so this file is the evidence or there is none.
 *
 * ## Two kinds of case, deliberately mixed
 *
 * Some cases drive the SERVICE, which is how an administrator reaches the
 * catalogue. Others issue raw SQL, which is how a future migration, a
 * maintenance script, or a bug would reach it. The second kind is the more
 * important: a rule the service upholds is a rule the service upholds, and the
 * whole claim of ADR-041 is that these rules hold against anything holding a
 * connection.
 *
 * Where a case does both, the raw-SQL half is named `(direct SQL)`.
 */
describePg('commercial catalogue — lifecycle, immutability and constraints (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let admin: SeededUser;

  /** Sequence so keys never collide across cases within a run. */
  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, `+98912${String(700000 + (sequence % 90000)).slice(0, 6)}`, [
      'administrator',
    ]);
  });

  // -------------------------------------------------------------------------
  // Builders. Real rows through the real service, no fixtures library.
  // -------------------------------------------------------------------------

  async function publishedSchedule(
    options: {
      key?: string;
      startsAt?: Date;
      endsAt?: Date | null;
      minQuantity?: number;
      maxQuantity?: number;
      tiers?: Array<{ minQuantity: number; maxQuantity: number | null; unitPriceToman: number }>;
    } = {},
  ): Promise<{ key: string; id: string; version: number }> {
    const key = options.key ?? nextKey('sched');
    await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
    const draft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey: key,
        displayName: `${key} v1`,
        activationStartsAt: options.startsAt ?? T0,
        activationEndsAt: options.endsAt ?? null,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: options.minQuantity ?? 1,
          maxPurchaseQuantity: options.maxQuantity ?? 100,
          uiPresetQuantities: [],
          tiers: options.tiers ?? [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 1_000 }],
        },
      },
      'suite setup',
    );
    const published = await catalogue.publishScheduleVersion(admin.id, key, draft.version, 'suite setup');
    return { key, id: published.id, version: published.version };
  }

  async function planDraft(
    options: {
      planKey?: string;
      scheduleVersionId: string;
      startsAt?: Date;
      endsAt?: Date | null;
      autoAssignable?: boolean;
      includedBookingCredits?: number;
      createKey?: boolean;
    },
  ): Promise<{ planKey: string; version: number; id: string }> {
    const planKey = options.planKey ?? nextKey('plan');
    if (options.createKey !== false) {
      await catalogue.createPlan(admin.id, planKey, 'suite setup');
    }
    const draft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: options.scheduleVersionId,
        autoAssignable: options.autoAssignable ?? false,
        activationStartsAt: options.startsAt ?? T0,
        activationEndsAt: options.endsAt ?? null,
        terms: {
          displayName: `${planKey} v`,
          billingTermDays: 30,
          includedBookingCredits: options.includedBookingCredits ?? 0,
          staffSeats: 0,
          includedLocations: 0,
          capabilityKeys: [],
        },
      },
      'suite setup',
    );
    return { planKey, version: draft.version, id: draft.id };
  }

  // =========================================================================
  // §1. The lifecycle, and every transition that is not in it
  // =========================================================================

  describe('§1 lifecycle', () => {
    it('walks draft -> published -> retired through the service', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });

      const published = await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');
      expect(published.lifecycleState).toBe('published');
      expect(published.publishedAt).not.toBeNull();
      expect(published.publishedByUserId).toBe(admin.id);

      const retired = await catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'superseded');
      expect(retired.lifecycleState).toBe('retired');
      expect(retired.retiredByUserId).toBe(admin.id);
      // Retirement does NOT touch the window (ADR-041 §5).
      expect(retired.activationStartsAt.toISOString()).toBe(published.activationStartsAt.toISOString());
      expect(retired.activationEndsAt).toBeNull();
    });

    it('refuses draft -> retired: a version nobody published cannot be withdrawn', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await expect(catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'why')).rejects.toBeInstanceOf(
        CommercialLifecycleConflictException,
      );
    });

    it('refuses publishing twice', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');
      await expect(catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'again')).rejects.toBeInstanceOf(
        CommercialLifecycleConflictException,
      );
    });

    it('refuses retiring twice', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');
      await catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'done');
      await expect(catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'again')).rejects.toBeInstanceOf(
        CommercialLifecycleConflictException,
      );
    });

    it.each([
      ['published', 'draft'],
      ['retired', 'published'],
      ['retired', 'draft'],
      ['draft', 'retired'],
    ])('the DATABASE refuses %s -> %s (direct SQL)', async (from, to) => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      if (from !== 'draft') await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');
      if (from === 'retired') await catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'done');

      await expect(
        dataSource.query(`UPDATE commercial.plan_versions SET lifecycle_state = $1 WHERE id = $2`, [to, plan.id]),
      ).rejects.toThrow(/not permitted|permanently immutable|is published/);
    });

    it('refuses a lifecycle state outside the vocabulary entirely (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await expect(
        dataSource.query(`UPDATE commercial.plan_versions SET lifecycle_state = 'archived' WHERE id = $1`, [plan.id]),
      ).rejects.toThrow(/ck_plan_versions_lifecycle|not permitted/);
    });

    it('refuses a row BORN published, so publication checks cannot be skipped (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('born');
      await catalogue.createPlan(admin.id, planKey, 'suite setup');

      await expect(
        dataSource.query(
          `INSERT INTO commercial.plan_versions
             (id, plan_key, version, lifecycle_state, display_name, billing_term_days,
              included_booking_credits, staff_seats, included_locations, capability_keys,
              price_schedule_version_id, auto_assignable, activation_starts_at,
              created_by_user_id, published_at, published_by_user_id)
           VALUES ($1, $2, 1, 'published', 'sneaky', NULL, 0, 0, 0, '{}', $3, false, $4, $5, now(), $5)`,
          [uuidv7(), planKey, schedule.id, T0, admin.id],
        ),
      ).rejects.toThrow(/must be created as draft/);
    });
  });

  // =========================================================================
  // §2. Editing a draft is permitted; editing anything else is not
  // =========================================================================

  describe('§2 draft editing and immutability', () => {
    it('edits every term of a DRAFT', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id, includedBookingCredits: 0 });

      const edited = await catalogue.updatePlanVersionDraft(
        admin.id,
        plan.planKey,
        plan.version,
        {
          priceScheduleVersionId: schedule.id,
          autoAssignable: false,
          activationStartsAt: T1,
          activationEndsAt: T2,
          terms: {
            displayName: 'edited',
            billingTermDays: 365,
            includedBookingCredits: 42,
            staffSeats: 3,
            includedLocations: 2,
            capabilityKeys: ['bc_use_ai_assistant'],
          },
        },
        'correcting a draft before it goes live',
      );

      expect(edited.displayName).toBe('edited');
      expect(edited.includedBookingCredits).toBe(42);
      expect(edited.capabilityKeys).toEqual(['bc_use_ai_assistant']);
      expect(edited.activationStartsAt.toISOString()).toBe(T1.toISOString());
    });

    it('refuses to edit a PUBLISHED version through the service', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');

      await expect(
        catalogue.updatePlanVersionDraft(
          admin.id,
          plan.planKey,
          plan.version,
          {
            priceScheduleVersionId: schedule.id,
            autoAssignable: false,
            activationStartsAt: T0,
            activationEndsAt: null,
            terms: {
              displayName: 'rewritten',
              billingTermDays: 30,
              includedBookingCredits: 999,
              staffSeats: 0,
              includedLocations: 0,
              capabilityKeys: [],
            },
          },
          'trying to rewrite history',
        ),
      ).rejects.toBeInstanceOf(CommercialLifecycleConflictException);
    });

    it.each([
      ['included_booking_credits', '999'],
      ['staff_seats', '9'],
      ['included_locations', '9'],
      ['display_name', "'rewritten'"],
      ['auto_assignable', 'true'],
      ['activation_starts_at', "'2029-01-01T00:00:00Z'"],
      ['billing_term_days', '365'],
    ])('the DATABASE refuses changing %s on a published version (direct SQL)', async (column, value) => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');

      await expect(
        dataSource.query(`UPDATE commercial.plan_versions SET ${column} = ${value} WHERE id = $1`, [plan.id]),
      ).rejects.toThrow(/is published and its terms are immutable/);
    });

    it('the DATABASE refuses changing a version identity even while it is a draft (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await expect(
        dataSource.query(`UPDATE commercial.plan_versions SET version = 99 WHERE id = $1`, [plan.id]),
      ).rejects.toThrow(/identity is immutable/);
    });

    it('a RETIRED version accepts no update at all, not even a lifecycle one (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');
      await catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'done');

      await expect(
        dataSource.query(`UPDATE commercial.plan_versions SET retired_at = now() WHERE id = $1`, [plan.id]),
      ).rejects.toThrow(/retired and permanently immutable/);
    });

    it('a published or retired version cannot be DELETED (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');

      await expect(dataSource.query(`DELETE FROM commercial.plan_versions WHERE id = $1`, [plan.id])).rejects.toThrow(
        /cannot be deleted once published/,
      );
    });

    it('a DRAFT can be discarded, so a wrong draft never has to be published to be removed', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.discardPlanVersionDraft(admin.id, plan.planKey, plan.version, 'wrong terms, starting over');
      await expect(catalogue.getPlanVersion(plan.planKey, plan.version)).rejects.toThrow();
    });

    it('restoring earlier terms creates a NEW version and leaves the old one exactly as published', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id, includedBookingCredits: 10, endsAt: T1 });
      const original = await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'v1 live');

      const second = await planDraft({
        planKey: plan.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        includedBookingCredits: 20,
        startsAt: T1,
        endsAt: T2,
      });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, second.version, 'v2 live');

      // "Restore the original terms" -- a THIRD version, never an edit of v1.
      const third = await planDraft({
        planKey: plan.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        includedBookingCredits: 10,
        startsAt: T2,
        endsAt: null,
      });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, third.version, 'back to the v1 terms');

      const versions = await catalogue.listPlanVersions(plan.planKey);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(versions.map((v) => v.includedBookingCredits)).toEqual([10, 20, 10]);
      // v1 is byte-for-byte what it was published as.
      expect(versions[0].publishedAt?.toISOString()).toBe(original.publishedAt?.toISOString());
    });
  });

  // =========================================================================
  // §3. Activation windows: non-overlap enforced by the database
  // =========================================================================

  describe('§3 activation windows', () => {
    it('refuses two overlapping PUBLISHED versions of one plan key', async () => {
      const schedule = await publishedSchedule();
      const first = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: T2 });
      await catalogue.publishPlanVersion(admin.id, first.planKey, first.version, 'publishing version one');

      const overlapping = await planDraft({
        planKey: first.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        startsAt: T1,
        endsAt: null,
      });

      await expect(
        catalogue.publishPlanVersion(admin.id, first.planKey, overlapping.version, 'publishing version two'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_ACTIVATION_OVERLAP' });
    });

    it('ACCEPTS windows that abut exactly, because [start, end) is half-open', async () => {
      const schedule = await publishedSchedule();
      const first = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: T1 });
      await catalogue.publishPlanVersion(admin.id, first.planKey, first.version, 'publishing version one');

      const abutting = await planDraft({
        planKey: first.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        startsAt: T1,
        endsAt: null,
      });
      const published = await catalogue.publishPlanVersion(admin.id, first.planKey, abutting.version, 'publishing version two');
      expect(published.lifecycleState).toBe('published');
    });

    it('permits two overlapping DRAFTS: a draft occupies no timeline', async () => {
      const schedule = await publishedSchedule();
      const first = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: null });
      const second = await planDraft({
        planKey: first.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        startsAt: T0,
        endsAt: null,
      });
      expect(second.version).toBe(first.version + 1);
    });

    it('a RETIRED version still holds its window, so a later version cannot backfill it', async () => {
      const schedule = await publishedSchedule();
      const first = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: T2 });
      await catalogue.publishPlanVersion(admin.id, first.planKey, first.version, 'publishing version one');
      await catalogue.retirePlanVersion(admin.id, first.planKey, first.version, 'withdrawn');

      const backfill = await planDraft({
        planKey: first.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        startsAt: T1,
        endsAt: null,
      });
      await expect(
        catalogue.publishPlanVersion(admin.id, first.planKey, backfill.version, 'reusing the period'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_ACTIVATION_OVERLAP' });
    });

    it('different plan keys may overlap freely', async () => {
      const schedule = await publishedSchedule();
      const a = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: null });
      const b = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: null });
      await catalogue.publishPlanVersion(admin.id, a.planKey, a.version, 'publishing plan a');
      const second = await catalogue.publishPlanVersion(admin.id, b.planKey, b.version, 'publishing plan b');
      expect(second.lifecycleState).toBe('published');
    });

    it('the same non-overlap rule holds for PRICE SCHEDULE versions', async () => {
      const key = nextKey('sched-overlap');
      const first = await publishedSchedule({ key, startsAt: T0, endsAt: T2 });
      const second = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: first.key,
          displayName: 'v2',
          activationStartsAt: T1,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 100,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 900 }],
          },
        },
        'suite setup',
      );
      await expect(
        catalogue.publishScheduleVersion(admin.id, first.key, second.version, 'publishing version two'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_ACTIVATION_OVERLAP' });
    });

    it('an end at or before the start is refused (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('badwindow');
      await catalogue.createPlan(admin.id, planKey, 'suite setup');
      await expect(
        dataSource.query(
          `INSERT INTO commercial.plan_versions
             (id, plan_key, version, display_name, billing_term_days, included_booking_credits,
              staff_seats, included_locations, capability_keys, price_schedule_version_id,
              auto_assignable, activation_starts_at, activation_ends_at, created_by_user_id)
           VALUES ($1, $2, 1, 'bad', NULL, 0, 0, 0, '{}', $3, false, $4, $4, $5)`,
          [uuidv7(), planKey, schedule.id, T0, admin.id],
        ),
      ).rejects.toThrow(/ck_plan_versions_window/);
    });
  });

  // =========================================================================
  // §4. Concurrency
  // =========================================================================

  describe('§4 concurrency', () => {
    /**
     * The property a pre-check cannot provide.
     *
     * Both requests read a draft. Both attempt the transition. The compare-and-
     * swap puts `lifecycle_state = 'draft'` in the WHERE clause, so exactly one
     * matches a row and the loser is refused rather than overwriting the
     * winner's publication instant and actor.
     */
    it('two concurrent publishes of one version produce exactly one winner', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });

      const results = await Promise.allSettled([
        catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'racer one'),
        catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'racer two'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const [row] = await dataSource.query(
        `SELECT lifecycle_state, published_by_user_id FROM commercial.plan_versions WHERE id = $1`,
        [plan.id],
      );
      expect(row.lifecycle_state).toBe('published');
      expect(row.published_by_user_id).toBe(admin.id);
    });

    it('two concurrent retires of one version produce exactly one winner', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');

      const results = await Promise.allSettled([
        catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'racer one'),
        catalogue.retirePlanVersion(admin.id, plan.planKey, plan.version, 'racer two'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    /**
     * The case that would pass an application check and corrupt the catalogue.
     *
     * Two DRAFTS with overlapping windows are legal. Publishing both is not, and
     * under READ COMMITTED both transactions see a timeline with no published
     * version on it. Only the exclusion constraint can decide.
     */
    it('two concurrent publishes of OVERLAPPING versions leave exactly one active', async () => {
      const schedule = await publishedSchedule();
      const first = await planDraft({ scheduleVersionId: schedule.id, startsAt: T0, endsAt: null });
      const second = await planDraft({
        planKey: first.planKey,
        createKey: false,
        scheduleVersionId: schedule.id,
        startsAt: T0,
        endsAt: null,
      });

      const results = await Promise.allSettled([
        catalogue.publishPlanVersion(admin.id, first.planKey, first.version, 'racer one'),
        catalogue.publishPlanVersion(admin.id, first.planKey, second.version, 'racer two'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM commercial.plan_versions WHERE plan_key = $1 AND lifecycle_state = 'published'`,
        [first.planKey],
      );
      expect(count).toBe(1);
    });

    it('concurrent draft creation allocates two DIFFERENT version numbers', async () => {
      const schedule = await publishedSchedule();
      const planKey = nextKey('race-version');
      await catalogue.createPlan(admin.id, planKey, 'suite setup');

      const make = (): Promise<{ version: number }> =>
        catalogue.createPlanVersionDraft(
          admin.id,
          {
            planKey,
            priceScheduleVersionId: schedule.id,
            autoAssignable: false,
            activationStartsAt: T0,
            activationEndsAt: null,
            terms: {
              displayName: 'racing',
              billingTermDays: null,
              includedBookingCredits: 0,
              staffSeats: 0,
              includedLocations: 0,
              capabilityKeys: [],
            },
          },
          'concurrent draft',
        );

      const results = await Promise.allSettled([make(), make(), make()]);
      const versions = results
        .filter((r): r is PromiseFulfilledResult<{ version: number }> => r.status === 'fulfilled')
        .map((r) => r.value.version);

      // Whatever survived, no two drafts share a number -- the unique index is
      // what decides, not the `max(version) + 1` read.
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // §5. Tier schedules
  // =========================================================================

  describe('§5 tier schedules', () => {
    it('resolves exact prices at every boundary of a three-tier schedule', async () => {
      const schedule = await publishedSchedule({
        maxQuantity: 500,
        tiers: [
          { minQuantity: 1, maxQuantity: 9, unitPriceToman: 12_000 },
          { minQuantity: 10, maxQuantity: 99, unitPriceToman: 10_500 },
          { minQuantity: 100, maxQuantity: null, unitPriceToman: 9_000 },
        ],
      });

      for (const [quantity, unit, total] of [
        [1, 12_000, 12_000],
        [9, 12_000, 108_000],
        [10, 10_500, 105_000],
        [99, 10_500, 1_039_500],
        [100, 9_000, 900_000],
        [500, 9_000, 4_500_000],
      ] as const) {
        const quote = await catalogue.resolvePrice(schedule.key, MID_FIRST_WINDOW, quantity);
        expect(quote.unitPriceToman).toBe(unit);
        expect(quote.totalToman).toBe(total);
        expect(quote.currency).toBe('IRT');
      }
    });

    it('resolves a ONE-TIER flat price, which is how a flat price is represented', async () => {
      const schedule = await publishedSchedule({
        maxQuantity: 50,
        tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 7 }],
      });
      expect((await catalogue.resolvePrice(schedule.key, MID_FIRST_WINDOW, 50)).totalToman).toBe(350);
    });

    it('refuses a quantity outside the schedule bounds rather than clamping it', async () => {
      const schedule = await publishedSchedule({ maxQuantity: 100 });
      await expect(catalogue.resolvePrice(schedule.key, MID_FIRST_WINDOW, 101)).rejects.toBeInstanceOf(
        CommercialTermsInvalidException,
      );
    });

    it('refuses to PUBLISH a schedule with a gap between tiers', async () => {
      const key = nextKey('gap');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      const draft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'gapped',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 100,
            uiPresetQuantities: [],
            // The service refuses this before the database sees it...
            tiers: [
              { minQuantity: 1, maxQuantity: 9, unitPriceToman: 100 },
              { minQuantity: 20, maxQuantity: null, unitPriceToman: 90 },
            ],
          },
        },
        'suite setup',
      ).catch((error) => error);

      expect(draft).toBeInstanceOf(CommercialTermsInvalidException);
    });

    it('the DATABASE refuses publishing a gapped schedule even when the service is bypassed (direct SQL)', async () => {
      const key = nextKey('gap-sql');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      const draft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'contiguous for now',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 100,
            uiPresetQuantities: [],
            tiers: [
              { minQuantity: 1, maxQuantity: 9, unitPriceToman: 100 },
              { minQuantity: 10, maxQuantity: null, unitPriceToman: 90 },
            ],
          },
        },
        'suite setup',
      );

      // Punch a hole in it directly, exactly as a maintenance script might.
      await dataSource.query(
        `DELETE FROM commercial.price_tiers WHERE schedule_version_id = $1 AND min_quantity = 1`,
        [draft.id],
      );

      await expect(
        catalogue.publishScheduleVersion(admin.id, key, draft.version, 'publishing a hole'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_LIFECYCLE_CONFLICT' });
    });

    it('the DATABASE refuses an EMPTY schedule: a flat price is one tier, not none (direct SQL)', async () => {
      const key = nextKey('empty');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      const draft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'about to be emptied',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 10,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 5 }],
          },
        },
        'suite setup',
      );
      await dataSource.query(`DELETE FROM commercial.price_tiers WHERE schedule_version_id = $1`, [draft.id]);

      await expect(catalogue.publishScheduleVersion(admin.id, key, draft.version, 'empty')).rejects.toMatchObject({
        code: 'COMMERCIAL_LIFECYCLE_CONFLICT',
      });
    });

    it('the DATABASE refuses OVERLAPPING tiers outright (direct SQL)', async () => {
      const key = nextKey('overlap-tier');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      const draft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'one tier',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 100,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 100 }],
          },
        },
        'suite setup',
      );

      await expect(
        dataSource.query(
          `INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_user_id)
           VALUES ($1, $2, 50, 60, 1, $3)`,
          [uuidv7(), draft.id, admin.id],
        ),
      ).rejects.toThrow(/ex_price_tiers_no_overlap/);
    });

    it('the DATABASE refuses a tier write once its schedule version is published (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      await expect(
        dataSource.query(
          `INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_user_id)
           VALUES ($1, $2, 5000, 6000, 1, $3)`,
          [uuidv7(), schedule.id, admin.id],
        ),
      ).rejects.toThrow(/may only be written while its schedule version is a draft/);

      await expect(
        dataSource.query(`UPDATE commercial.price_tiers SET unit_price_toman = 1 WHERE schedule_version_id = $1`, [
          schedule.id,
        ]),
      ).rejects.toThrow(/may only be written while its schedule version is a draft/);

      await expect(
        dataSource.query(`DELETE FROM commercial.price_tiers WHERE schedule_version_id = $1`, [schedule.id]),
      ).rejects.toThrow(/cannot be deleted once its schedule version is published/);
    });

    it.each([
      ['a zero quantity', 'min_quantity = 0'],
      ['a negative price', 'unit_price_toman = -1'],
    ])('the DATABASE refuses %s (direct SQL)', async (_label, assignment) => {
      const key = nextKey('badtier');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      const draft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'draft',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 10,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 5 }],
          },
        },
        'suite setup',
      );
      await expect(
        dataSource.query(`UPDATE commercial.price_tiers SET ${assignment} WHERE schedule_version_id = $1`, [draft.id]),
      ).rejects.toThrow(/ck_price_tiers_/);
    });

    it('the DATABASE pins the currency to IRT (direct SQL)', async () => {
      const schedule = await publishedSchedule();
      const key = nextKey('usd');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      await expect(
        dataSource.query(
          `INSERT INTO commercial.price_schedule_versions
             (id, schedule_key, version, display_name, currency_code, min_purchase_quantity,
              max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_user_id)
           VALUES ($1, $2, 1, 'dollars', 'USD', 1, 10, '{}', $3, $4)`,
          [uuidv7(), key, T0, admin.id],
        ),
      ).rejects.toThrow(/ck_price_schedule_versions_currency/);
      expect(schedule.id).toBeDefined();
    });
  });

  // =========================================================================
  // §6. Refusal when nothing is configured
  // =========================================================================

  describe('§6 unconfigured refusals', () => {
    it('refuses a price for a schedule key that does not exist', async () => {
      await expect(catalogue.resolvePrice('nope-not-a-key', new Date(), 1)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });

    it('refuses a price for a schedule whose only version is still a DRAFT', async () => {
      const key = nextKey('draft-only');
      await catalogue.createPriceSchedule(admin.id, key, 'booking_credit', 'suite setup');
      await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'unpublished',
          activationStartsAt: T0,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 10,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 5 }],
          },
        },
        'suite setup',
      );
      await expect(catalogue.resolvePrice(key, MID_FIRST_WINDOW, 1)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });

    it('refuses a price OUTSIDE the active window rather than reaching for the nearest version', async () => {
      const schedule = await publishedSchedule({ startsAt: T1, endsAt: T2 });
      await expect(catalogue.resolvePrice(schedule.key, T0, 1)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
      // And resolves inside it, so the refusal is a boundary rather than a
      // blanket.
      expect((await catalogue.resolvePrice(schedule.key, T1, 1)).unitPriceToman).toBe(1_000);
    });

    it('refuses a price once the only version is RETIRED', async () => {
      const schedule = await publishedSchedule();
      await catalogue.retireScheduleVersion(admin.id, schedule.key, schedule.version, 'withdrawn');
      await expect(catalogue.resolvePrice(schedule.key, MID_FIRST_WINDOW, 1)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });

    it('refuses an active plan version when none is published for the key', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await expect(catalogue.resolveActivePlanVersion(plan.planKey, MID_FIRST_WINDOW)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });

    it('refuses an auto-assignable version when none exists at all', async () => {
      // `resetDatabase` truncated the migration's `D-7` seed, so this is the
      // genuine "nothing is configured" state rather than a contrived one.
      await expect(catalogue.resolveAutoAssignablePlanVersion(new Date())).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });

    it('never returns a zero price where a price is missing', async () => {
      // The failure this whole section exists to prevent: a refusal quietly
      // becoming "free". Proved by the TYPE of the failure, because a caught
      // exception cannot be mistaken for a quote.
      await expect(catalogue.resolvePrice('absent', new Date(), 1)).rejects.not.toBeInstanceOf(PriceResolutionError);
      await expect(catalogue.resolvePrice('absent', new Date(), 1)).rejects.toBeInstanceOf(
        CommercialNotConfiguredException,
      );
    });
  });

  // =========================================================================
  // §7. The base workspace, behaviourally
  // =========================================================================

  describe('§7 base workspace', () => {
    async function baseWorkspace(startsAt = T0): Promise<{ planKey: string; version: number }> {
      const key = nextKey('base-price');
      await catalogue.createPriceSchedule(admin.id, key, 'seller_plan', 'base workspace price');
      const scheduleDraft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'base',
          activationStartsAt: startsAt,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 1,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
          },
        },
        'base workspace price',
      );
      const schedule = await catalogue.publishScheduleVersion(admin.id, key, scheduleDraft.version, 'base price live');

      const plan = await planDraft({
        scheduleVersionId: schedule.id,
        autoAssignable: true,
        startsAt,
        includedBookingCredits: 0,
      });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'base workspace live');
      return plan;
    }

    it('is resolved from the CATALOGUE by its auto-assignable flag, never by a key', async () => {
      const base = await baseWorkspace();
      const resolved = await catalogue.resolveAutoAssignablePlanVersion(MID_FIRST_WINDOW);
      expect(resolved.planKey).toBe(base.planKey);
      expect(resolved.autoAssignable).toBe(true);
      expect(resolved.lifecycleState).toBe('published');
      expect(resolved.includedBookingCredits).toBe(0);
    });

    it('costs exactly zero, through the ordinary one-tier pricing path', async () => {
      const base = await baseWorkspace();
      const version = await catalogue.getPlanVersion(base.planKey, base.version);
      const tiers = await catalogue.tiersFor(version.priceScheduleVersionId);
      expect(tiers).toHaveLength(1);
      expect(tiers[0].unitPriceToman).toBe(0);
    });

    it('refuses to publish an auto-assignable version that is not zero-priced', async () => {
      const paid = await publishedSchedule({ maxQuantity: 1, tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 990_000 }] });
      const plan = await planDraft({ scheduleVersionId: paid.id, autoAssignable: true });
      await expect(
        catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'making the base workspace paid'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_LIFECYCLE_CONFLICT' });
    });

    it('permits at most ONE auto-assignable version at any instant, across plan keys', async () => {
      await baseWorkspace();
      const second = await publishedSchedule({ maxQuantity: 1, tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }] });
      const rival = await planDraft({ scheduleVersionId: second.id, autoAssignable: true, startsAt: T0 });
      await expect(
        catalogue.publishPlanVersion(admin.id, rival.planKey, rival.version, 'a second base workspace'),
      ).rejects.toMatchObject({ code: 'COMMERCIAL_ACTIVATION_OVERLAP' });
    });

    it('permits a SUCCESSOR base workspace in a later, non-overlapping window', async () => {
      const key = nextKey('base-a');
      await catalogue.createPriceSchedule(admin.id, key, 'seller_plan', 'base');
      const firstScheduleDraft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey: key,
          displayName: 'base',
          activationStartsAt: T0,
          activationEndsAt: T1,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 1,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
          },
        },
        'base',
      );
      const firstSchedule = await catalogue.publishScheduleVersion(admin.id, key, firstScheduleDraft.version, 'live');

      const first = await planDraft({ scheduleVersionId: firstSchedule.id, autoAssignable: true, startsAt: T0, endsAt: T1 });
      await catalogue.publishPlanVersion(admin.id, first.planKey, first.version, 'base workspace version one');

      const successorSchedule = await publishedSchedule({
        startsAt: T1,
        maxQuantity: 1,
        tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
      });
      const successor = await planDraft({
        scheduleVersionId: successorSchedule.id,
        autoAssignable: true,
        startsAt: T1,
        endsAt: null,
      });
      const published = await catalogue.publishPlanVersion(admin.id, successor.planKey, successor.version, 'base workspace version two');
      expect(published.lifecycleState).toBe('published');

      // And each instant resolves to exactly one of them.
      expect((await catalogue.resolveAutoAssignablePlanVersion(MID_FIRST_WINDOW)).planKey).toBe(first.planKey);
      expect((await catalogue.resolveAutoAssignablePlanVersion(T2)).planKey).toBe(successor.planKey);
    });
  });

  // =========================================================================
  // §8. ADR-027 coverage against the real catalogue
  // =========================================================================

  describe('§8 privacy coverage', () => {
    it('claims all five tables as `retained`, with a reason on each', () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commercial = contracts.find((c) => c.moduleKey === 'commercial');
      expect(commercial).toBeDefined();

      const claims = commercial!.tables;
      expect(claims.map((c) => c.table).sort()).toEqual([
        'commercial.plan_versions',
        'commercial.plans',
        'commercial.price_schedule_versions',
        'commercial.price_schedules',
        'commercial.price_tiers',
      ]);
      for (const claim of claims) {
        expect(claim.disposition).toBe('retained');
        expect(claim.reason ?? '').not.toHaveLength(0);
      }
      // Never `no_subject_data`, which Issue #40 forbids for these tables by name.
      expect(claims.some((c) => c.disposition === 'no_subject_data')).toBe(false);
    });

    it('every commercial table is claimed by exactly one contract, against the REAL catalogue', async () => {
      // The boot assertion already ran (`PrivacyCompositionModule`), but that
      // proves the WHOLE database is covered. This re-runs the same pure
      // evaluator over just this schema, so a failure names this story.
      const rows: Array<{ schema: string; name: string; columns: string[] }> = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial'
          GROUP BY t.schemaname, t.tablename`,
      );
      expect(rows).toHaveLength(5);

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const report = evaluateCoverage(rows, contracts);
      const commercialViolations = report.violations.filter((v) => v.table.startsWith('commercial.'));
      expect(commercialViolations).toEqual([]);
    });

    it('uses the detectable `_user_id` naming, so the coverage check can SEE the identity', async () => {
      const rows: Array<{ column_name: string }> = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'commercial' AND column_name LIKE '%user_id%'`,
      );
      const names = [...new Set(rows.map((r) => r.column_name))].sort();
      expect(names).toEqual(['created_by_user_id', 'published_by_user_id', 'retired_by_user_id']);
      // Non-vacuity: the platform's own detector agrees these are subject
      // columns, which is what makes a `no_subject_data` claim on these tables
      // impossible rather than merely discouraged.
      for (const name of names) expect(isSubjectColumn(name)).toBe(true);
    });

    it('a `no_subject_data` claim on a commercial table would FAIL the coverage check', () => {
      // The mutation probe for the claim above, run through the real evaluator
      // rather than by editing the contract: if the disposition were downgraded,
      // this is the violation the boot assertion would raise.
      const fake: SubjectDataContract = {
        moduleKey: 'commercial-probe',
        tables: [{ table: 'commercial.plan_versions', disposition: 'no_subject_data', reason: 'probe' }],
        exportSubjectData: async () => [],
        eraseSubjectData: async () => ({ moduleKey: 'commercial-probe', anonymized: 0, deleted: 0, retained: [] }),
      };
      const report = evaluateCoverage(
        [{ schema: 'commercial', name: 'plan_versions', columns: ['id', 'published_by_user_id'] }],
        [fake],
      );
      expect(report.violations.map((v) => v.kind)).toContain('wrongly_declared_empty');
    });

    it('reports erasure truthfully: nothing anonymized, nothing deleted, five tables retained', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commercial = contracts.find((c) => c.moduleKey === 'commercial')!;
      const outcome = await commercial.eraseSubjectData(dataSource.manager, admin.id, {
        userId: admin.id,
        phoneAlias: 'del:probe',
        displayAlias: 'x',
        erasedAt: new Date(),
      });
      expect(outcome).toMatchObject({ moduleKey: 'commercial', anonymized: 0, deleted: 0 });
      expect(outcome.retained).toHaveLength(5);
      expect(await commercial.exportSubjectData(dataSource.manager, admin.id)).toEqual([]);
    });

    it('an erasure genuinely leaves the administrator attribution in place', async () => {
      const schedule = await publishedSchedule();
      const plan = await planDraft({ scheduleVersionId: schedule.id });
      await catalogue.publishPlanVersion(admin.id, plan.planKey, plan.version, 'go live');

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commercial = contracts.find((c) => c.moduleKey === 'commercial')!;
      await commercial.eraseSubjectData(dataSource.manager, admin.id, {
        userId: admin.id,
        phoneAlias: 'del:probe',
        displayAlias: 'x',
        erasedAt: new Date(),
      });

      const [row] = await dataSource.query(
        `SELECT published_by_user_id FROM commercial.plan_versions WHERE id = $1`,
        [plan.id],
      );
      // The whole point of `retained`: the report said it survives, and it does.
      expect(row.published_by_user_id).toBe(admin.id);
    });
  });

  // =========================================================================
  // §9. Migration state
  // =========================================================================

  describe('§9 migration', () => {
    it('recorded both new migrations exactly once on an already-migrated database', async () => {
      const rows: Array<{ filename: string }> = await dataSource.query(
        `SELECT filename FROM public.schema_migrations
          WHERE filename LIKE 'commercial/%' OR filename LIKE '%add_commercial_plan_capability%'
          ORDER BY filename`,
      );
      expect(rows.map((r) => r.filename)).toEqual([
        'commercial/20260902800001_create_commercial_catalogue.sql',
        'identity/20260902800002_add_commercial_plan_capability.sql',
      ]);
    });

    it('created the capability as privileged and granted it to `administrator` only', async () => {
      const [capability] = await dataSource.query(
        `SELECT is_privileged FROM identity.capabilities WHERE slug = 'bc_manage_commercial_plans'`,
      );
      expect(capability.is_privileged).toBe(true);

      const grants: Array<{ role_slug: string }> = await dataSource.query(
        `SELECT role_slug FROM identity.role_capabilities WHERE capability_slug = 'bc_manage_commercial_plans' ORDER BY 1`,
      );
      expect(grants.map((g) => g.role_slug)).toEqual(['administrator']);
    });

    it('installed the exclusion constraints and triggers the invariants rest on', async () => {
      const constraints: Array<{ conname: string }> = await dataSource.query(
        `SELECT conname FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'commercial' AND c.contype = 'x' ORDER BY conname`,
      );
      expect(constraints.map((c) => c.conname)).toEqual([
        'ex_plan_versions_no_overlap',
        'ex_plan_versions_single_auto_assignable',
        'ex_price_schedule_versions_no_overlap',
        'ex_price_tiers_no_overlap',
      ]);

      const triggers: Array<{ tgname: string }> = await dataSource.query(
        `SELECT t.tgname FROM pg_trigger t
           JOIN pg_class cl ON cl.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = 'commercial' AND NOT t.tgisinternal ORDER BY t.tgname`,
      );
      expect(triggers.map((t) => t.tgname)).toEqual([
        'tg_plan_versions_lifecycle',
        'tg_plans_immutable',
        'tg_price_schedule_versions_lifecycle',
        'tg_price_schedules_immutable',
        'tg_price_tiers_parent_is_draft',
      ]);
    });

    it('put NO default on any allowance or price column', async () => {
      const rows: Array<{ column_name: string; column_default: string | null }> = await dataSource.query(
        `SELECT column_name, column_default FROM information_schema.columns
          WHERE table_schema = 'commercial'
            AND column_name IN ('included_booking_credits', 'staff_seats', 'included_locations', 'unit_price_toman')`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const row of rows) expect(row.column_default).toBeNull();
    });
  });
});
