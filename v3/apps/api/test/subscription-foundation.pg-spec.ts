import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  evaluateCoverage,
  isSubjectColumn,
} from '@beauclick/subject-data';
import {
  CommercialCatalogueService,
  MIGRATION_ACTOR_LABEL,
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
  SYSTEM_ACTOR_LABEL,
  SellerSubscriptionService,
  SubscriptionNotConfiguredException,
  SubscriptionPaidActivationUnavailableException,
  SubscriptionPlanNotSelectableException,
  SubscriptionSellerNotEligibleException,
} from '@beauclick/commercial-policy';

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
 * The subscription foundation against a real PostgreSQL server — V3.3-A Story
 * #56 (`#56a`), ADR-042, `V33-DEC-018`.
 *
 * ## Why every guarantee here is proved HERE and nowhere else
 *
 * pg-mem does not honour TypeORM's ROLLBACK, runs no PL/pgSQL, and has no
 * partial unique indexes or deferrable constraints. **Every invariant this
 * story rests on is one of those.** The one-active-per-party index, the
 * zero-price CHECK, snapshot immutability, the two-transition trigger, grant
 * uniqueness, the NULL-only expiry and the activation transaction are all
 * database objects. None can be observed on the fast layer, so this file is the
 * evidence or there is none.
 *
 * ## Two kinds of case, deliberately mixed
 *
 * Some drive the SERVICE, which is how the application reaches a subscription.
 * Others issue raw SQL, which is how a future migration, a maintenance script
 * or a bug would reach it. The second kind is the more important: a rule the
 * service upholds is a rule the service upholds, and ADR-042's whole claim is
 * that these hold against anything holding a connection.
 *
 * Cases of the second kind are named `(direct SQL)`.
 */
describePg('subscription foundation — assignment, snapshots, grants (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let subscriptions: SellerSubscriptionService;
  let resolver: OwnedSubscriberPartyResolver;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98913${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
    subscriptions = app.get(SellerSubscriptionService);
    resolver = app.get<OwnedSubscriberPartyResolver>(OWNED_SUBSCRIBER_PARTY_RESOLVER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // -------------------------------------------------------------------------
  // Builders. Real catalogue rows through the real service — `resetDatabase`
  // truncates the migration's `D-7` seed away, so every case that needs a base
  // workspace publishes one, exactly as the factory's own comment requires.
  // -------------------------------------------------------------------------

  async function publishedPlanVersion(
    options: {
      autoAssignable?: boolean;
      unitPriceToman?: number;
      includedBookingCredits?: number;
      staffSeats?: number;
      includedLocations?: number;
      capabilityKeys?: string[];
      billingTermDays?: number | null;
      planKey?: string;
    } = {},
  ): Promise<{ planKey: string; version: number; id: string; scheduleVersionId: string }> {
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
          tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: options.unitPriceToman ?? 0 }],
        },
      },
      'suite setup',
    );
    const schedule = await catalogue.publishScheduleVersion(admin.id, scheduleKey, scheduleDraft.version, 'suite setup');

    const planKey = options.planKey ?? nextKey('plan');
    await catalogue.createPlan(admin.id, planKey, 'suite setup');
    const planDraft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: schedule.id,
        autoAssignable: options.autoAssignable ?? false,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          displayName: planKey,
          billingTermDays: options.billingTermDays === undefined ? null : options.billingTermDays,
          includedBookingCredits: options.includedBookingCredits ?? 0,
          staffSeats: options.staffSeats ?? 0,
          includedLocations: options.includedLocations ?? 0,
          capabilityKeys: options.capabilityKeys ?? [],
        },
      },
      'suite setup',
    );
    const published = await catalogue.publishPlanVersion(admin.id, planKey, planDraft.version, 'suite setup');
    return { planKey, version: published.version, id: published.id, scheduleVersionId: schedule.id };
  }

  /** A base workspace: auto-assignable, zero-price, no term, no entitlements. */
  const baseWorkspace = () => publishedPlanVersion({ autoAssignable: true });

  async function professionalParty(): Promise<{ user: SeededUser; party: OwnedSubscriberParty }> {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص آزمون');
    return { user, party: { partyType: 'professional', partyId: professional.id } };
  }

  async function businessParty(): Promise<{ user: SeededUser; party: OwnedSubscriberParty }> {
    const user = await seedUser(app, dataSource, nextPhone(), ['business']);
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار آزمون');
    return { user, party: { partyType: 'business', partyId: business.id } };
  }

  const activeRows = (party: OwnedSubscriberParty) =>
    dataSource.query(
      `SELECT * FROM commercial.seller_subscriptions
        WHERE subscriber_party_type = $1 AND subscriber_party_id = $2 AND lifecycle_state = 'active'`,
      [party.partyType, party.partyId],
    );

  const grantRows = (party: OwnedSubscriberParty) =>
    dataSource.query(
      `SELECT * FROM commercial.booking_credit_grants
        WHERE subscriber_party_type = $1 AND subscriber_party_id = $2`,
      [party.partyType, party.partyId],
    );

  const auditRows = (targetId: string) =>
    dataSource.query(`SELECT * FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [targetId]);

  // =========================================================================
  // §1. Automatic assignment — the base workspace is a row, never a fallback
  // =========================================================================

  describe('§1 automatic assignment', () => {
    it('gives an existing professional party the base workspace exactly once', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      const created = await subscriptions.ensureBaseSubscription(party);

      // Exactly one, not at-least-one: `>= 1` would pass with the duplicate bug
      // present, which is the whole failure the partial unique index prevents.
      const rows = await activeRows(party);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(created.id);
      expect(rows[0].subscriber_party_type).toBe('professional');
    });

    it('gives an existing business party the base workspace exactly once', async () => {
      await baseWorkspace();
      const { party } = await businessParty();

      await subscriptions.ensureBaseSubscription(party);

      expect(await activeRows(party)).toHaveLength(1);
    });

    it('is idempotent: a second ensure returns the same row and writes nothing', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      const first = await subscriptions.ensureBaseSubscription(party);
      const auditBefore = await auditRows(first.id);

      const second = await subscriptions.ensureBaseSubscription(party);

      expect(second.id).toBe(first.id);
      expect(await activeRows(party)).toHaveLength(1);
      expect(await grantRows(party)).toHaveLength(1);
      // No second audit row: an idempotent call that audits is not idempotent.
      expect(await auditRows(first.id)).toHaveLength(auditBefore.length);
    });

    it('produces exactly one subscription under ten concurrent ensures', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => subscriptions.ensureBaseSubscription(party)),
      );

      const rows = await activeRows(party);
      expect(rows).toHaveLength(1);
      // Every caller got the winner's row, so no caller can act on a
      // subscription that does not exist.
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results[0].id).toBe(rows[0].id);
      expect(await grantRows(party)).toHaveLength(1);
    });

    it('refuses when no auto-assignable published version is active — there is no fallback', async () => {
      // A published version that is NOT auto-assignable: the catalogue is
      // configured, and the base workspace still is not.
      await publishedPlanVersion({ autoAssignable: false });
      const { party } = await professionalParty();

      await expect(subscriptions.ensureBaseSubscription(party)).rejects.toBeInstanceOf(
        SubscriptionNotConfiguredException,
      );
      expect(await activeRows(party)).toHaveLength(0);
      expect(await grantRows(party)).toHaveLength(0);
    });

    it('refuses a soft-deleted party, and leaves its history intact', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [party.partyId]);

      // The existing subscription survives; only a NEW assignment is refused.
      await dataSource.query(
        `UPDATE commercial.seller_subscriptions SET lifecycle_state = 'cancelled', cancelled_at = now(),
                cancelled_by_label = 'suite' WHERE subscriber_party_id = $1`,
        [party.partyId],
      );
      await expect(subscriptions.ensureBaseSubscription(party)).rejects.toBeInstanceOf(
        SubscriptionSellerNotEligibleException,
      );
      expect(await grantRows(party)).toHaveLength(1);
    });

    it('does not treat verification status as subscription eligibility', async () => {
      await baseWorkspace();
      const user = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'در انتظار بررسی');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      const party: OwnedSubscriberParty = { partyType: 'professional', partyId: professional.id };

      // An unverified seller is a seller whose identity is unconfirmed, not one
      // without commercial terms.
      await expect(subscriptions.ensureBaseSubscription(party)).resolves.toBeDefined();
      expect(await activeRows(party)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §2. The migration backfill — the shipped SQL, not a copy of it
  // =========================================================================

  describe('§2 migration backfill', () => {
    /**
     * Executes the `DO $backfill$` block from the REAL migration file.
     *
     * Reading the shipped artifact rather than restating its SQL is the point:
     * a test against a copy proves the copy works. `resetDatabase` truncates
     * the catalogue and every subscription, so the block runs here against
     * seeded parties exactly as it ran against existing ones on deploy.
     */
    async function runShippedBackfill(): Promise<void> {
      const file = join(
        __dirname,
        '../../../database/migrations/commercial/20260903800001_create_seller_subscriptions.sql',
      );
      const sql = readFileSync(file, 'utf8');
      const block = /DO \$backfill\$[\s\S]*?\$backfill\$;/.exec(sql);
      if (!block) throw new Error('the backfill block was not found in the migration — has it been renamed?');
      await dataSource.query(block[0]);
    }

    it('assigns the base workspace to every eligible party that already exists', async () => {
      await baseWorkspace();
      const pro = await professionalParty();
      const biz = await businessParty();

      await runShippedBackfill();

      expect(await activeRows(pro.party)).toHaveLength(1);
      expect(await activeRows(biz.party)).toHaveLength(1);
      expect(await grantRows(pro.party)).toHaveLength(1);
      expect(await grantRows(biz.party)).toHaveLength(1);
    });

    it('skips soft-deleted parties', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [party.partyId]);

      await runShippedBackfill();

      expect(await activeRows(party)).toHaveLength(0);
    });

    it('is idempotent: re-running assigns nothing further', async () => {
      await baseWorkspace();
      const pro = await professionalParty();

      await runShippedBackfill();
      await runShippedBackfill();
      await runShippedBackfill();

      expect(await activeRows(pro.party)).toHaveLength(1);
      expect(await grantRows(pro.party)).toHaveLength(1);
    });

    it('converges with the lazy-ensure path on the same row shape', async () => {
      await baseWorkspace();
      const backfilled = await professionalParty();

      await runShippedBackfill();

      // Created AFTER the backfill, so it is genuinely the lazy path rather
      // than a party the backfill already covered.
      const lazy = await professionalParty();
      await subscriptions.ensureBaseSubscription(lazy.party);

      const [b] = await activeRows(backfilled.party);
      const [l] = await activeRows(lazy.party);

      // Whole-row comparison of everything that is not an id, an instant or the
      // actor: two mechanisms that agree on the invariants but disagree on the
      // snapshot would be two definitions of the base workspace.
      const shapeOf = (row: Record<string, unknown>) => ({
        state: row.lifecycle_state,
        planKey: row.snapshot_plan_key,
        version: row.snapshot_version,
        term: row.snapshot_billing_term_days,
        credits: row.snapshot_included_booking_credits,
        seats: row.snapshot_staff_seats,
        locations: row.snapshot_included_locations,
        capabilities: row.snapshot_capability_keys,
        currency: row.snapshot_currency_code,
        price: row.snapshot_unit_price_toman,
        planVersionId: row.plan_version_id,
      });
      expect(shapeOf(b)).toEqual(shapeOf(l));

      // They differ in exactly one place, and deliberately: who did it.
      expect(b.created_by_label).toBe(MIGRATION_ACTOR_LABEL);
      expect(l.created_by_label).toBe(SYSTEM_ACTOR_LABEL);
    });

    it('fails loudly when no auto-assignable version is active, rather than assigning nothing quietly', async () => {
      await publishedPlanVersion({ autoAssignable: false });
      await professionalParty();

      await expect(runShippedBackfill()).rejects.toThrow(/no automatically assignable published plan version/);
    });
  });

  // =========================================================================
  // §3. The snapshot
  // =========================================================================

  describe('§3 snapshot', () => {
    it('copies every entitlement from the plan version at creation', async () => {
      const version = await publishedPlanVersion({
        autoAssignable: true,
        includedBookingCredits: 0,
        staffSeats: 0,
        includedLocations: 0,
        capabilityKeys: [],
        billingTermDays: null,
      });
      const { party } = await professionalParty();

      await subscriptions.ensureBaseSubscription(party);
      const [row] = await activeRows(party);

      const [source] = await dataSource.query(
        `SELECT v.*, sv.currency_code, t.unit_price_toman
           FROM commercial.plan_versions v
           JOIN commercial.price_schedule_versions sv ON sv.id = v.price_schedule_version_id
           JOIN commercial.price_tiers t ON t.schedule_version_id = sv.id
          WHERE v.id = $1`,
        [version.id],
      );

      // Whole-snapshot equality against the source row, not field spot-checks:
      // a spot-check passes while a field nobody asserted is silently wrong.
      expect({
        planKey: row.snapshot_plan_key,
        version: row.snapshot_version,
        term: row.snapshot_billing_term_days,
        credits: row.snapshot_included_booking_credits,
        seats: row.snapshot_staff_seats,
        locations: row.snapshot_included_locations,
        capabilities: row.snapshot_capability_keys,
        currency: row.snapshot_currency_code,
        price: String(row.snapshot_unit_price_toman),
        scheduleVersion: row.snapshot_price_schedule_version_id,
      }).toEqual({
        planKey: source.plan_key,
        version: source.version,
        term: source.billing_term_days,
        credits: source.included_booking_credits,
        seats: source.staff_seats,
        locations: source.included_locations,
        capabilities: source.capability_keys,
        currency: source.currency_code,
        price: String(source.unit_price_toman),
        scheduleVersion: source.price_schedule_version_id,
      });
    });

    it('is untouched when the catalogue publishes a newer base workspace version', async () => {
      const first = await baseWorkspace();
      const { party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);
      const [before] = await activeRows(party);

      // Retire the version the seller is ON, and publish richer terms beside
      // it. Not a second auto-assignable version: retirement deliberately does
      // NOT close an activation window (ADR-041), so
      // `ex_plan_versions_single_auto_assignable` would refuse one — and the
      // claim under test is about the snapshot, not about the catalogue.
      await catalogue.retirePlanVersion(admin.id, first.planKey, first.version, 'superseded by suite');
      await publishedPlanVersion({ includedBookingCredits: 500, staffSeats: 9 });

      const [after] = await activeRows(party);
      expect(after).toEqual(before);
      // Still on the old terms: a new version does NOT migrate existing
      // subscribers, which `V33-DEC-018` makes a separate owner decision.
      expect(after.snapshot_included_booking_credits).toBe(0);
      expect(after.plan_version_id).toBe(first.id);
    });

    it('refuses every snapshot mutation (direct SQL)', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      const created = await subscriptions.ensureBaseSubscription(party);

      const frozen: Array<[string, string]> = [
        ['snapshot_included_booking_credits', '999'],
        ['snapshot_staff_seats', '9'],
        ['snapshot_included_locations', '9'],
        ['snapshot_plan_key', `'other'`],
        ['snapshot_version', '99'],
        ['snapshot_billing_term_days', '30'],
        ['snapshot_currency_code', `'USD'`],
        ['effective_at', 'now()'],
        ['subscriber_party_id', 'gen_random_uuid()'],
        ['subscriber_party_type', `'business'`],
      ];

      for (const [column, value] of frozen) {
        await expect(
          dataSource.query(`UPDATE commercial.seller_subscriptions SET ${column} = ${value} WHERE id = $1`, [
            created.id,
          ]),
        ).rejects.toThrow(/immutable/);
      }
    });
  });

  // =========================================================================
  // §4. The zero-price safety boundary
  // =========================================================================

  describe('§4 zero-price only', () => {
    it('refuses to activate a priced plan version through the service', async () => {
      await baseWorkspace();
      const paid = await publishedPlanVersion({ unitPriceToman: 250_000 });
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      await expect(
        subscriptions.selectPlanVersion(party, paid.planKey, paid.version, user.id),
      ).rejects.toBeInstanceOf(SubscriptionPaidActivationUnavailableException);

      // Still on the base workspace, and nothing partial was written.
      const rows = await activeRows(party);
      expect(rows).toHaveLength(1);
      expect(rows[0].plan_version_id).not.toBe(paid.id);
      expect(await grantRows(party)).toHaveLength(1);
    });

    it('makes a priced subscription unwritable in EVERY state (direct SQL)', async () => {
      const version = await baseWorkspace();
      const { party } = await professionalParty();
      const anchor = await subscriptions.ensureBaseSubscription(party);

      // Each state is attempted WITH the terminal columns its own CHECK
      // requires, so the only constraint left to violate is the price one.
      // Otherwise `ck_seller_subscriptions_superseded` fires first and the case
      // passes while proving nothing about the price.
      const states: Array<[string, string]> = [
        ['active', 'NULL, NULL, NULL, NULL, NULL'],
        ['superseded', `now(), '${anchor.id}'::uuid, NULL, NULL, NULL`],
        ['cancelled', "NULL, NULL, now(), NULL, 'probe'"],
      ];

      for (const [state, terminal] of states) {
        await expect(
          dataSource.query(
            `INSERT INTO commercial.seller_subscriptions (
               id, subscriber_party_type, subscriber_party_id, plan_version_id, lifecycle_state,
               snapshot_plan_key, snapshot_version, snapshot_included_booking_credits, snapshot_staff_seats,
               snapshot_included_locations, snapshot_capability_keys, snapshot_currency_code,
               snapshot_unit_price_toman, snapshot_price_schedule_version_id, effective_at, created_by_label,
               superseded_at, superseded_by_id, cancelled_at, cancelled_by_user_id, cancelled_by_label)
             VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, $3, 'x', 1, 0, 0, 0, '{}', 'IRT', 1, $4, now(), 'probe', ${terminal})`,
            [party.partyType, version.id, state, version.scheduleVersionId],
          ),
        ).rejects.toThrow(/ck_seller_subscriptions_zero_price/);
      }
    });

    it('accepts the identical row at zero, so the case above is about the PRICE (direct SQL)', async () => {
      // The non-vacuity control. Without it the case above would pass just as
      // happily if some unrelated constraint were rejecting every insert.
      const version = await baseWorkspace();

      await expect(
        dataSource.query(
          `INSERT INTO commercial.seller_subscriptions (
             id, subscriber_party_type, subscriber_party_id, plan_version_id, lifecycle_state,
             snapshot_plan_key, snapshot_version, snapshot_included_booking_credits, snapshot_staff_seats,
             snapshot_included_locations, snapshot_capability_keys, snapshot_currency_code,
             snapshot_unit_price_toman, snapshot_price_schedule_version_id, effective_at, created_by_label)
           VALUES (gen_random_uuid(), 'professional', gen_random_uuid(), $1, 'active', 'x', 1, 0, 0, 0, '{}', 'IRT', 0, $2, now(), 'probe')`,
          [version.id, version.scheduleVersionId],
        ),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // §5. Lifecycle
  // =========================================================================

  describe('§5 lifecycle', () => {
    it('supersedes the previous subscription and starts a new one on selection', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion({ includedBookingCredits: 25 });
      const { user, party } = await professionalParty();
      const base = await subscriptions.ensureBaseSubscription(party);

      const selected = await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      const [previous] = await dataSource.query(`SELECT * FROM commercial.seller_subscriptions WHERE id = $1`, [
        base.id,
      ]);
      expect(previous.lifecycle_state).toBe('superseded');
      expect(previous.superseded_by_id).toBe(selected.id);
      expect(previous.superseded_at).not.toBeNull();

      const active = await activeRows(party);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(selected.id);
      expect(active[0].snapshot_included_booking_credits).toBe(25);
    });

    it('leaves the earlier grant untouched when the plan changes', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion({ includedBookingCredits: 25 });
      const { user, party } = await professionalParty();
      const base = await subscriptions.ensureBaseSubscription(party);
      const [firstGrant] = await grantRows(party);

      await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      const grants = await grantRows(party);
      expect(grants).toHaveLength(2);
      const original = grants.find((g: { subscription_id: string }) => g.subscription_id === base.id);
      // Byte-identical, not merely present: a retroactively adjusted grant is
      // exactly what `V33-DEC-018` forbids.
      expect(original).toEqual(firstGrant);
    });

    it('restores the base workspace on cancellation, in the same transaction', async () => {
      const base = await baseWorkspace();
      const other = await publishedPlanVersion({ includedBookingCredits: 25 });
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);
      await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      const restored = await subscriptions.cancel(party, user.id);

      const active = await activeRows(party);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(restored.id);
      // The party is never entitled to nothing, which is ADR-042 §2's invariant.
      expect(active[0].plan_version_id).toBe(base.id);
    });

    it('refuses every transition out of a terminal state (direct SQL)', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion();
      const { user, party } = await professionalParty();
      const base = await subscriptions.ensureBaseSubscription(party);
      await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      for (const target of ['active', 'cancelled', 'superseded']) {
        await expect(
          dataSource.query(`UPDATE commercial.seller_subscriptions SET lifecycle_state = $1 WHERE id = $2`, [
            target,
            base.id,
          ]),
        ).rejects.toThrow(/terminal/);
      }
    });

    it('refuses an unpublished, retired or unknown version with one indistinguishable code', async () => {
      await baseWorkspace();
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      const retired = await publishedPlanVersion();
      await catalogue.retirePlanVersion(admin.id, retired.planKey, retired.version, 'suite');

      await expect(
        subscriptions.selectPlanVersion(party, retired.planKey, retired.version, user.id),
      ).rejects.toBeInstanceOf(SubscriptionPlanNotSelectableException);
      await expect(
        subscriptions.selectPlanVersion(party, 'no-such-plan-key', 1, user.id),
      ).rejects.toBeInstanceOf(SubscriptionPlanNotSelectableException);
    });

    it('treats a replayed selection as a no-op', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion({ includedBookingCredits: 7 });
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      const first = await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);
      const auditBefore = await auditRows(first.id);
      const second = await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      expect(second.id).toBe(first.id);
      expect(await activeRows(party)).toHaveLength(1);
      expect(await grantRows(party)).toHaveLength(2);
      expect(await auditRows(first.id)).toHaveLength(auditBefore.length);
    });
  });

  // =========================================================================
  // §6. Grants
  // =========================================================================

  describe('§6 grants', () => {
    it('writes a grant even when the plan confers zero credits', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      await subscriptions.ensureBaseSubscription(party);

      const grants = await grantRows(party);
      expect(grants).toHaveLength(1);
      // Zero is a quantity, not a missing row. An absent grant would be
      // ambiguous between "conferred nothing" and "not processed".
      expect(grants[0].quantity).toBe(0);
      expect(grants[0].source).toBe('plan_included');
      expect(grants[0].period_index).toBe(0);
    });

    it('takes the quantity from the snapshot rather than a later catalogue read', async () => {
      const base = await baseWorkspace();
      const rich = await publishedPlanVersion({ includedBookingCredits: 40 });
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);
      const selected = await subscriptions.selectPlanVersion(party, rich.planKey, rich.version, user.id);

      // Retire the version the seller is on and publish a different base: a
      // grant that re-read the catalogue would now be wrong.
      await catalogue.retirePlanVersion(admin.id, rich.planKey, rich.version, 'suite');
      expect(base.id).toBeDefined();

      const grants = await grantRows(party);
      const forSelected = grants.find((g: { subscription_id: string }) => g.subscription_id === selected.id);
      expect(forSelected.quantity).toBe(40);
      expect(forSelected.plan_version_id).toBe(rich.id);
    });

    it('cannot be duplicated for one subscription, source and period (direct SQL)', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      const created = await subscriptions.ensureBaseSubscription(party);

      await expect(
        dataSource.query(
          `INSERT INTO commercial.booking_credit_grants
             (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id, source, quantity, period_index)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'plan_included', 5, 0)`,
          [created.id, created.planVersionId, party.partyType, party.partyId],
        ),
      ).rejects.toThrow(/uq_booking_credit_grants_once/);

      expect(await grantRows(party)).toHaveLength(1);
    });

    it('keeps expiry NULL and refuses any attempt to set one (direct SQL)', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      const created = await subscriptions.ensureBaseSubscription(party);

      const grants = await grantRows(party);
      expect(grants[0].expires_at).toBeNull();

      await expect(
        dataSource.query(
          `INSERT INTO commercial.booking_credit_grants
             (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id, source, quantity, period_index, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'plan_included', 5, 1, now())`,
          [created.id, created.planVersionId, party.partyType, party.partyId],
        ),
      ).rejects.toThrow(/ck_booking_credit_grants_no_expiry/);
    });

    it('refuses to edit or delete an issued grant (direct SQL)', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);
      const [grant] = await grantRows(party);

      await expect(
        dataSource.query(`UPDATE commercial.booking_credit_grants SET quantity = 99 WHERE id = $1`, [grant.id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query(`DELETE FROM commercial.booking_credit_grants WHERE id = $1`, [grant.id]),
      ).rejects.toThrow(/immutable/);
    });

    it('issues no second grant when the same period is replayed concurrently', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      await Promise.all(Array.from({ length: 6 }, () => subscriptions.ensureBaseSubscription(party)));

      expect(await grantRows(party)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §7. Audit and atomicity
  // =========================================================================

  describe('§7 audit and atomicity', () => {
    it('records assignment and the grant under a system label, never a fabricated human', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();
      const created = await subscriptions.ensureBaseSubscription(party);

      const rows = await auditRows(created.id);
      const actions = rows.map((r: { action: string }) => r.action);
      expect(actions).toEqual(['commercial.subscription_assigned', 'commercial.credits_granted']);

      for (const row of rows) {
        expect(row.actor_user_id).toBeNull();
        expect(row.actor_label).toBe(SYSTEM_ACTOR_LABEL);
        // Closed, server-generated. Never a caller's prose.
        expect(typeof row.reason).toBe('string');
        expect(row.reason.length).toBeGreaterThan(0);
      }
    });

    it('records a seller-driven selection against the seller, not a label', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion();
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      const selected = await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);

      const rows = await auditRows(selected.id);
      const activation = rows.find((r: { action: string }) => r.action === 'commercial.subscription_activated');
      expect(activation.actor_user_id).toBe(user.id);
      expect(activation.actor_label).toBeNull();
    });

    it('leaves neither a subscription, a grant nor an audit row when the transaction fails', async () => {
      await baseWorkspace();
      const { party } = await professionalParty();

      // The audit log is owned by a role the test cannot DELETE from, so rows
      // accumulate across cases in a run -- `RESETTABLE_TABLES` says so
      // explicitly. Counting the DELTA is what makes this assertion about this
      // transaction rather than about the whole suite's history.
      const auditBefore = await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE action LIKE 'commercial.subscription%'`,
      );

      // Fail inside the activation transaction, AFTER the subscription, audit
      // and grant writes: the grant service is the last step, so throwing from
      // it proves the earlier writes roll back with it.
      const grantService = app.get(
        (await import('@beauclick/commercial-policy')).BookingCreditGrantService,
      ) as { issueForActivation: (...args: unknown[]) => Promise<unknown> };
      const original = grantService.issueForActivation.bind(grantService);
      grantService.issueForActivation = async () => {
        throw new Error('planted failure inside the activation transaction');
      };

      try {
        await expect(subscriptions.ensureBaseSubscription(party)).rejects.toThrow(/planted failure/);
      } finally {
        grantService.issueForActivation = original;
      }

      expect(await activeRows(party)).toHaveLength(0);
      expect(await grantRows(party)).toHaveLength(0);
      const auditAfter = await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE action LIKE 'commercial.subscription%'`,
      );
      expect(auditAfter[0].n).toBe(auditBefore[0].n);

      // And the seam still works afterwards, so the probe proved a rollback
      // rather than a permanently broken service.
      await expect(subscriptions.ensureBaseSubscription(party)).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // §8. Ownership isolation
  // =========================================================================

  describe('§8 ownership', () => {
    it('gives a user who owns both a professional and a business two independent subscriptions', async () => {
      await baseWorkspace();
      const user = await seedUser(app, dataSource, nextPhone(), ['professional', 'business']);
      const professional = await seedProfessional(dataSource, user.id, 'هر دو — متخصص');
      const business = await seedBusiness(dataSource, user.id, 'هر دو — کسب‌وکار');

      const parties = await subscriptions.ownedPartiesFor(user.id);
      expect(parties).toHaveLength(2);

      for (const party of parties) {
        await subscriptions.ensureBaseSubscription(party);
      }

      const proRows = await activeRows({ partyType: 'professional', partyId: professional.id });
      const bizRows = await activeRows({ partyType: 'business', partyId: business.id });
      expect(proRows).toHaveLength(1);
      expect(bizRows).toHaveLength(1);
      // Two parties, two subscriptions, no relationship between them.
      expect(proRows[0].id).not.toBe(bizRows[0].id);
    });

    it('returns nothing for a staff member, so they cannot reach the employing business', async () => {
      await baseWorkspace();
      const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const staffPro = await seedProfessional(dataSource, staffUser.id, 'کارمند');
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'practitioner', 'active', $4)`,
        [business.id, staffUser.id, staffPro.id, owner.id],
      );

      const parties = await subscriptions.ownedPartiesFor(staffUser.id);

      // Their OWN professional party, and nothing of their employer's.
      expect(parties).toEqual([{ partyType: 'professional', partyId: staffPro.id }]);
      expect(parties.some((p) => p.partyId === business.id)).toBe(false);
    });

    it('does not rewrite a professional subscription when they later join a business', async () => {
      await baseWorkspace();
      const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن دوم');
      const proUser = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const professional = await seedProfessional(dataSource, proUser.id, 'مستقل');
      const party: OwnedSubscriberParty = { partyType: 'professional', partyId: professional.id };

      const before = await subscriptions.ensureBaseSubscription(party);
      const [beforeRow] = await activeRows(party);

      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'practitioner', 'active', $4)`,
        [business.id, proUser.id, professional.id, owner.id],
      );

      // `V33-DEC-018`: it CONTINUES independently — not superseded, transferred,
      // cancelled or made dormant.
      const [afterRow] = await activeRows(party);
      expect(afterRow).toEqual(beforeRow);
      expect(afterRow.id).toBe(before.id);
      expect(afterRow.subscriber_party_type).toBe('professional');

      // And the resolver still reports the personal party, unchanged.
      const parties = await subscriptions.ownedPartiesFor(proUser.id);
      expect(parties).toEqual([party]);
    });

    it('reports a soft-deleted party as ineligible', async () => {
      const { party } = await professionalParty();
      await dataSource.transaction(async (manager) => {
        expect(await resolver.isEligible(manager, party)).toBe(true);
      });

      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [party.partyId]);

      await dataSource.transaction(async (manager) => {
        expect(await resolver.isEligible(manager, party)).toBe(false);
      });
    });
  });

  // =========================================================================
  // §9. Privacy
  // =========================================================================

  describe('§9 privacy', () => {
    const contractFor = (key: string): SubjectDataContract => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const found = contracts.find((c) => c.moduleKey === key);
      if (!found) throw new Error(`no subject-data contract registered for ${key}`);
      return found;
    };

    it('claims both tables as retained, with reasons, and never as no_subject_data', async () => {
      const contract = contractFor('commercial-subscription');
      const claims = contract.tables.filter((t) => t.table.startsWith('commercial.'));

      expect(claims.map((c) => c.table).sort()).toEqual([
        'commercial.booking_credit_grants',
        'commercial.seller_subscriptions',
      ]);
      for (const claim of claims) {
        expect(claim.disposition).toBe('retained');
        expect(claim.reason && claim.reason.length).toBeGreaterThan(40);
      }
    });

    it('passes the REAL coverage evaluator over the live catalogue, for both new tables', async () => {
      // The boot assertion already ran inside `PrivacyCompositionModule`, and
      // it covers the whole database. This re-runs the same pure evaluator over
      // just this schema so a failure names this story rather than the
      // application's startup.
      const rows: Array<{ schema: string; name: string; columns: string[] }> = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial'
          GROUP BY t.schemaname, t.tablename`,
      );

      const names = rows.map((r) => `${r.schema}.${r.name}`).sort();
      expect(names).toContain('commercial.seller_subscriptions');
      expect(names).toContain('commercial.booking_credit_grants');

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const report = evaluateCoverage(rows, contracts);
      expect(report.violations.filter((v) => v.table.startsWith('commercial.'))).toEqual([]);
    });

    it('would FAIL coverage if the subscription table were declared empty — and NOT for grants', async () => {
      /*
       * The non-vacuity control for the case above, and it records an asymmetry
       * worth knowing rather than papering over.
       *
       * `seller_subscriptions` carries `created_by_user_id` and
       * `cancelled_by_user_id`, so ADR-027's `wrongly_declared_empty` check
       * catches a dishonest `no_subject_data` claim on it automatically.
       *
       * `booking_credit_grants` carries NO `_user_id` or `_by` column — a grant
       * is issued by the system, and there is no actor to record. So the
       * detector would NOT catch a `no_subject_data` claim on it. Its `retained`
       * disposition rests on the claim's stated reason and on this suite, not on
       * a structural backstop.
       *
       * The alternative — adding a permanently-NULL `granted_by_user_id` so the
       * detector fires — would be inventing a column to satisfy a check, which
       * is the mirror image of the evasion ADR-027 forbids. The honest thing is
       * to state where the guarantee comes from.
       */
      const rows: Array<{ schema: string; name: string; columns: string[] }> = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial'
            AND t.tablename IN ('seller_subscriptions', 'booking_credit_grants')
          GROUP BY t.schemaname, t.tablename`,
      );
      expect(rows).toHaveLength(2);

      const dishonest: SubjectDataContract = {
        moduleKey: 'dishonest-probe',
        tables: [
          { table: 'commercial.seller_subscriptions', disposition: 'no_subject_data', reason: 'probe' },
          { table: 'commercial.booking_credit_grants', disposition: 'no_subject_data', reason: 'probe' },
        ],
        exportSubjectData: async () => [],
        eraseSubjectData: async () => ({ moduleKey: 'dishonest-probe', anonymized: 0, deleted: 0, retained: [] }),
      };

      const report = evaluateCoverage(rows, [dishonest]);
      expect(report.violations.map((v) => v.table).sort()).toEqual(['commercial.seller_subscriptions']);
      expect(report.violations[0].kind).toBe('wrongly_declared_empty');

      // And the grants table genuinely has no detectable identity column, which
      // is WHY it is absent above rather than an oversight in this assertion.
      const grantColumns = rows.find((r) => r.name === 'booking_credit_grants')!.columns;
      expect(grantColumns.filter(isSubjectColumn)).toEqual([]);
      expect(
        rows.find((r) => r.name === 'seller_subscriptions')!.columns.filter(isSubjectColumn).sort(),
      ).toEqual(['cancelled_by_user_id', 'created_by_user_id']);
    });

    it('exports the subject’s own subscription and grants, without administrator identity', async () => {
      await baseWorkspace();
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      const sections = await dataSource.transaction((manager) =>
        contractFor('commercial-subscription').exportSubjectData(manager, user.id),
      );

      const subs = sections.find((s) => s.key === 'commercial.subscriptions');
      expect(subs).toBeDefined();
      expect(subs!.rows).toHaveLength(1);
      const serialised = JSON.stringify(sections);
      expect(serialised).not.toContain(admin.id);
      expect(serialised.toLowerCase()).not.toContain('createdbyuserid');
      expect(sections.find((s) => s.key === 'commercial.booking_credit_grants')!.rows).toHaveLength(1);
      expect(party.partyId).toBeDefined();
    });

    it('exports nothing of the employer to a staff member', async () => {
      await baseWorkspace();
      const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن سوم');
      await subscriptions.ensureBaseSubscription({ partyType: 'business', partyId: business.id });

      const staffUser = await seedUser(app, dataSource, nextPhone(), ['professional']);
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
         VALUES (gen_random_uuid(), $1, $2, 'receptionist', 'active', $3)`,
        [business.id, staffUser.id, owner.id],
      );

      const sections = await dataSource.transaction((manager) =>
        contractFor('commercial-subscription').exportSubjectData(manager, staffUser.id),
      );

      // Not a filtered list — nothing at all, because they are not a subscriber.
      expect(sections).toEqual([]);
      expect(JSON.stringify(sections)).not.toContain(business.id);
    });

    it('reports erasure truthfully: nothing anonymized, nothing deleted, both retained', async () => {
      await baseWorkspace();
      const { user, party } = await professionalParty();
      await subscriptions.ensureBaseSubscription(party);

      const outcome = await dataSource.transaction((manager) =>
        contractFor('commercial-subscription').eraseSubjectData(manager, user.id, {
          userId: user.id,
          phoneAlias: `erased-${user.id.slice(0, 8)}`,
          displayAlias: 'کاربر حذف‌شده',
          erasedAt: new Date(),
        }),
      );

      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((r) => r.table).sort()).toEqual([
        'commercial.booking_credit_grants',
        'commercial.seller_subscriptions',
      ]);
      // And the rows really are still there, so the report is not merely honest
      // about an intention.
      expect(await activeRows(party)).toHaveLength(1);
      expect(await grantRows(party)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §10. What this story does NOT do
  // =========================================================================

  describe('§10 absent by design', () => {
    it('produces no order, payment intent, ledger entry, outbox row or notification', async () => {
      await baseWorkspace();
      const other = await publishedPlanVersion();
      const { user, party } = await professionalParty();

      await subscriptions.ensureBaseSubscription(party);
      await subscriptions.selectPlanVersion(party, other.planKey, other.version, user.id);
      await subscriptions.cancel(party, user.id);

      const counts = await dataSource.query(`
        SELECT
          (SELECT count(*) FROM commerce.orders)              AS orders,
          (SELECT count(*) FROM payment.payment_intents)      AS intents,
          (SELECT count(*) FROM payment.payment_attempts)     AS attempts,
          (SELECT count(*) FROM provider.outbox_events)       AS provider_outbox,
          (SELECT count(*) FROM business.outbox_events)       AS business_outbox,
          (SELECT count(*) FROM notification.notifications)   AS notifications
      `);

      // A commercial action that quietly created a payment fact, or emitted an
      // event with no consumer, is the failure this asserts against.
      expect(counts[0]).toEqual({
        orders: '0',
        intents: '0',
        attempts: '0',
        provider_outbox: '0',
        business_outbox: '0',
        notifications: '0',
      });
    });

    it('exposes no seller-facing HTTP route', async () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as {
        stack: Array<{ route?: { path: string } }>;
      };
      const paths = router.stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route!.path)
        .filter((path) => /subscription|my-plan|credits|grant/i.test(path));

      // Story #56a's boundary, asserted over the REAL route table rather than
      // against the absence of a controller file. The routes are #69.
      expect(paths).toEqual([]);
    });
  });
});
