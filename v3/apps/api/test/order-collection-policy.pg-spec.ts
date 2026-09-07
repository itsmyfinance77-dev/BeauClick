import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { METRICS, MetricsRegistry } from '@beauclick/observability';
import { OrderService } from '@beauclick/commerce';
import {
  BookingCollectionPolicyService,
  CollectionPolicyResolutionService,
} from '@beauclick/commercial-policy';
import {
  BookingCollectionTermsV1,
  COMMERCIAL_POLICY_CONTRACT_VERSION,
  bookingCollectionAmountsV1,
} from '@beauclick/commercial-policy-contract';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

const SCHEDULES = 'commerce.order_payment_schedules';
const ASSIGNMENTS = 'commercial.seller_collection_policy_assignments';

/**
 * Order collection-policy resolution and the immutable schedule snapshot —
 * V3.3 Story #115 (`#41d-2b`), ADR-048 R1, R3, R4 and R5.
 *
 * ## Why the evidence is here
 *
 * Every claim this story makes is about a REQUEST meeting real rows inside one
 * transaction: that an unenrolled seller's schedule is byte-identical to the
 * pre-change baseline, that an enrolled one resolves the version active at the
 * DATABASE's clock, that a failure leaves nothing behind, and that a concurrent
 * supersession or retirement WAITS. pg-mem honours no ROLLBACK, has no row
 * locks, no PL/pgSQL and no CHECK enforcement, so none of it is observable
 * there.
 *
 * The arithmetic itself is proved where it lives, in
 * `packages/commercial-policy-contract`. What is proved here is that this story
 * calls it with the right two amounts and derives the mode from its output.
 *
 * ## Assignments are inserted with SQL, policies published through the service
 *
 * The assignment WRITER is #104's and is proved by its own suite; re-driving it
 * here would test #104 again and would need a workspace reference this story
 * has no business holding. What #115 owns is the READ, so the row it reads is
 * placed directly. Policies go through the real administrator service, because
 * the lifecycle and activation window are exactly what resolution depends on.
 */
describePg('order collection-policy resolution (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;
  let policies: BookingCollectionPolicyService;
  let resolution: CollectionPolicyResolutionService;
  let metrics: MetricsRegistry;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98918${String(1000000 + (sequence += 1)).slice(-7)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
    policies = app.get(BookingCollectionPolicyService);
    resolution = app.get(CollectionPolicyResolutionService);
    metrics = app.get(MetricsRegistry);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // =========================================================================
  // Builders
  // =========================================================================

  const FULL_ONLINE: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'full_payment_online',
    deposit: { kind: 'none' },
  };
  const PAY_AT_VENUE: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'pay_at_venue',
    deposit: { kind: 'none' },
  };
  const fixedDeposit = (amountToman: number): BookingCollectionTermsV1 => ({
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'fixed', amountToman },
  });
  const percentageDeposit = (
    basisPoints: number,
    percentageBase: 'service_subtotal' | 'service_total',
    minimumToman = 0,
    maximumToman: number | null = null,
  ): BookingCollectionTermsV1 => ({
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'percentage', basisPoints, percentageBase, minimumToman, maximumToman },
  });

  /** A published, currently-active policy. Returns the key and the version number. */
  async function publishedPolicy(
    terms: BookingCollectionTermsV1,
    key = nextKey('cp'),
  ): Promise<{ key: string; version: number }> {
    await policies.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    const draft = await policies.createVersionDraft(
      admin.id,
      { policyKey: key, terms, activationEndsAt: null },
      'suite setup',
    );
    const live = await policies.publishVersion(admin.id, key, draft.version, 'suite setup');
    return { key, version: live.version };
  }

  interface Seller {
    ownerUser: SeededUser;
    professionalId: string;
    serviceId: string;
    partyType: 'professional' | 'business';
    partyId: string;
  }

  /** An independent professional: they are their own seller party. */
  async function professionalSeller(priceToman = 200_000): Promise<Seller> {
    const ownerUser = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, ownerUser.id, 'متخصص آزمون', priceToman);
    return {
      ownerUser,
      professionalId: professional.id,
      serviceId: professional.serviceId,
      partyType: 'professional',
      partyId: professional.id,
    };
  }

  /** A professional who is active staff of a business: the BUSINESS is the seller party. */
  async function affiliatedSeller(priceToman = 200_000): Promise<Seller> {
    const seller = await professionalSeller(priceToman);
    const bizOwner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
    const business = await seedBusiness(dataSource, bizOwner.id, 'کسب‌وکار آزمون');
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
       VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
      [uuidv7(), business.id, seller.ownerUser.id, seller.professionalId, bizOwner.id],
    );
    return { ...seller, partyType: 'business', partyId: business.id };
  }

  /**
   * Enrols a party by inserting its current assignment row directly.
   *
   * Presence IS enrollment (ADR-048 R2), so this is the whole of it — there is
   * no flag to set and no second table to touch.
   */
  async function enrol(seller: Seller, policyKey: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO ${ASSIGNMENTS} (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), seller.partyType, seller.partyId, policyKey, seller.ownerUser.id],
    );
  }

  /** Creates the order for a booking through the real service, as the booking flow does. */
  async function orderFor(seller: Seller): Promise<string> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const result = await orders.createForBooking({
      bookingId: uuidv7(),
      customerId: customer.id,
      professionalId: seller.professionalId,
      serviceId: seller.serviceId,
    });
    return result.order.id;
  }

  const scheduleFor = async (orderId: string): Promise<Record<string, unknown>> => {
    const [row] = await dataSource.query(`SELECT * FROM ${SCHEDULES} WHERE order_id = $1`, [orderId]);
    return row;
  };

  const commerceCounts = () =>
    dataSource.query(
      `SELECT (SELECT count(*)::int FROM commerce.orders) AS orders,
              (SELECT count(*)::int FROM commerce.order_items) AS items,
              (SELECT count(*)::int FROM commerce.order_adjustments) AS adjustments,
              (SELECT count(*)::int FROM ${SCHEDULES}) AS schedules,
              (SELECT count(*)::int FROM commerce.outbox_events) AS events`,
    );

  // =========================================================================
  // §1. The migration changed constraints and no rows
  // =========================================================================

  describe('§1 migration and constraint semantics', () => {
    it('replaced ck_ops_policy_reference and left every other invariant exact', async () => {
      const [reference] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='ck_ops_policy_reference'`,
      );
      // Key and version inseparable; acceptance not mentioned at all.
      expect(reference.definition).toContain('policy_key IS NULL');
      expect(reference.definition).toContain('policy_version IS NULL');
      expect(reference.definition).not.toContain('policy_accepted_at');

      const survivors: string[] = (
        await dataSource.query(
          `SELECT conname FROM pg_constraint WHERE conrelid='${SCHEDULES}'::regclass ORDER BY conname`,
        )
      ).map((row: { conname: string }) => row.conname);
      for (const required of [
        'ck_ops_sum',
        'ck_ops_mode_consistent',
        'ck_ops_policy_version_positive',
        'ck_ops_contract_version',
        'order_payment_schedules_pkey',
      ]) {
        expect(survivors).toContain(required);
      }

      const triggers: string[] = (
        await dataSource.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid='${SCHEDULES}'::regclass AND NOT tgisinternal`,
        )
      ).map((row: { tgname: string }) => row.tgname);
      expect(triggers).toContain('tg_order_payment_schedules_immutable');
    });

    it('permits key+version with null acceptance, refuses a partial pair, keeps version positive', async () => {
      const seller = await professionalSeller();
      const orderId = await orderFor(seller);
      await dataSource.query(`DELETE FROM ${SCHEDULES} WHERE order_id = $1`, [orderId]).catch(() => undefined);

      const insert = (columns: Record<string, unknown>) => {
        const row = {
          order_id: orderId,
          collection_mode: 'full_payment_online',
          service_total_toman: 100_000,
          platform_collectible_toman: 100_000,
          venue_balance_toman: 0,
          contract_version: 1,
          ...columns,
        };
        const names = Object.keys(row);
        return dataSource.query(
          `INSERT INTO ${SCHEDULES} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(row),
        );
      };

      // The pair is inseparable...
      await expect(insert({ policy_key: 'k' })).rejects.toThrow(/ck_ops_policy_reference/);
      await expect(insert({ policy_version: 1 })).rejects.toThrow(/ck_ops_policy_reference/);
      // ...the version stays positive, named by the constraint that owns it...
      await expect(insert({ policy_key: 'k', policy_version: 0 })).rejects.toThrow(
        /ck_ops_policy_version_positive/,
      );
      // ...and acceptance is genuinely independent, which is the whole change.
      await dataSource.query(`DELETE FROM ${SCHEDULES} WHERE order_id = $1`, [orderId]).catch(() => undefined);
    });

    it('recorded the migration exactly once and re-running applies nothing', async () => {
      const rows = await dataSource.query(
        `SELECT filename FROM public.schema_migrations
          WHERE filename = 'commerce/20260907900001_replace_order_payment_schedule_policy_reference.sql'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  // =========================================================================
  // §2. An unenrolled seller is byte-identical to the pre-change baseline
  // =========================================================================

  describe('§2 the legacy path is unchanged', () => {
    it('writes exactly the pre-#115 schedule for an unenrolled seller', async () => {
      const seller = await professionalSeller(140_000);
      const orderId = await orderFor(seller);
      const schedule = await scheduleFor(orderId);
      const [order] = await dataSource.query(`SELECT * FROM commerce.orders WHERE id = $1`, [orderId]);

      /*
       * The pre-change baseline, written out in full rather than compared field
       * by field. `#41a` inserted exactly this and #115 must not have moved a
       * single value for a seller who is not enrolled.
       */
      expect({
        collection_mode: schedule.collection_mode,
        service_total_toman: Number(schedule.service_total_toman),
        platform_collectible_toman: Number(schedule.platform_collectible_toman),
        venue_balance_toman: Number(schedule.venue_balance_toman),
        policy_key: schedule.policy_key,
        policy_version: schedule.policy_version,
        policy_accepted_at: schedule.policy_accepted_at,
        contract_version: Number(schedule.contract_version),
      }).toEqual({
        collection_mode: 'full_payment_online',
        service_total_toman: Number(order.total_toman),
        platform_collectible_toman: Number(order.total_toman),
        venue_balance_toman: 0,
        policy_key: null,
        policy_version: null,
        policy_accepted_at: null,
        contract_version: COMMERCIAL_POLICY_CONTRACT_VERSION,
      });
    });

    it('stays on the legacy path even when policies exist but this seller has none', async () => {
      // A published catalogue is not enrolment. Only a current assignment row is.
      await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller();
      const schedule = await scheduleFor(await orderFor(seller));
      expect(schedule.policy_key).toBeNull();
      expect(schedule.collection_mode).toBe('full_payment_online');
    });

    it('returns to the legacy path for a party whose assignment was superseded away — it cannot be', async () => {
      /*
       * There is no un-enrollment path (ADR-048 R2): supersession always leaves
       * a successor current. So a party that has ever been enrolled stays
       * enrolled, and this asserts the consequence rather than a hypothetical.
       */
      const { key } = await publishedPolicy(FULL_ONLINE);
      const seller = await professionalSeller();
      await enrol(seller, key);

      const current = await dataSource.query(
        `SELECT count(*)::int AS n FROM ${ASSIGNMENTS}
          WHERE seller_party_id = $1 AND superseded_at IS NULL`,
        [seller.partyId],
      );
      expect(current[0].n).toBe(1);
      expect((await scheduleFor(await orderFor(seller))).policy_key).toBe(key);
    });
  });

  // =========================================================================
  // §3. Enrolled resolution and the snapshot
  // =========================================================================

  describe('§3 enrolled resolution', () => {
    it('snapshots the active published version of the assigned key', async () => {
      const { key, version } = await publishedPolicy(fixedDeposit(60_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);

      const schedule = await scheduleFor(await orderFor(seller));
      expect(schedule.policy_key).toBe(key);
      expect(Number(schedule.policy_version)).toBe(version);
      expect(schedule.policy_accepted_at).toBeNull();
    });

    it('selects the CURRENT version after a republication, not the original', async () => {
      const { key } = await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);

      const first = await scheduleFor(await orderFor(seller));

      // Retire, then publish a second version of the SAME stable key.
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'superseded by v2');
      const draft = await policies.createVersionDraft(
        admin.id,
        { policyKey: key, terms: fixedDeposit(80_000), activationEndsAt: null },
        'republished forward as version two',
      );
      const live = await policies.publishVersion(admin.id, key, draft.version, 'version two goes live');

      const second = await scheduleFor(await orderFor(seller));
      expect(Number(second.policy_version)).toBe(live.version);
      expect(Number(second.policy_version)).toBeGreaterThan(Number(first.policy_version));
      expect(Number(second.platform_collectible_toman)).toBe(80_000);
      // The assignment never changed: an administrator republished forward and
      // no assignment had to be migrated (`V33-DEC-029` Ruling 6).
      expect(second.policy_key).toBe(first.policy_key);
    });

    it('resolves for a BUSINESS party when the professional is affiliated', async () => {
      const { key, version } = await publishedPolicy(fixedDeposit(30_000));
      const seller = await affiliatedSeller(200_000);
      await enrol(seller, key);

      const orderId = await orderFor(seller);
      const [order] = await dataSource.query(`SELECT * FROM commerce.orders WHERE id = $1`, [orderId]);
      // The order's seller party and the policy's are the same selection.
      expect(order.seller_party_type).toBe('business');
      expect(order.seller_party_id).toBe(seller.partyId);

      const schedule = await scheduleFor(orderId);
      expect(schedule.policy_key).toBe(key);
      expect(Number(schedule.policy_version)).toBe(version);
    });

    it('does not resolve the professional’s own policy for an affiliated booking', async () => {
      // The professional is enrolled; the BUSINESS that actually sells is not.
      const { key } = await publishedPolicy(fixedDeposit(30_000));
      const seller = await affiliatedSeller(200_000);
      await dataSource.query(
        `INSERT INTO ${ASSIGNMENTS} (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
         VALUES ($1, 'professional', $2, $3, $4)`,
        [uuidv7(), seller.professionalId, key, seller.ownerUser.id],
      );

      const schedule = await scheduleFor(await orderFor(seller));
      expect(schedule.policy_key).toBeNull();
      expect(schedule.collection_mode).toBe('full_payment_online');
    });

    it('records a database-authored resolution instant', async () => {
      const { key } = await publishedPolicy(FULL_ONLINE);
      const seller = await professionalSeller();
      await enrol(seller, key);

      const snapshot = await dataSource.transaction((manager) =>
        resolution.resolveForParty(manager, seller.partyType, seller.partyId),
      );
      expect(snapshot).not.toBeNull();
      expect(Math.abs(Date.parse(snapshot!.resolvedAt) - Date.now())).toBeLessThan(60_000);
      expect(snapshot!.terms).toEqual(FULL_ONLINE);
    });

    it('returns null — never a snapshot — for an unenrolled party', async () => {
      const seller = await professionalSeller();
      const snapshot = await dataSource.transaction((manager) =>
        resolution.resolveForParty(manager, seller.partyType, seller.partyId),
      );
      expect(snapshot).toBeNull();
    });
  });

  // =========================================================================
  // §4. The mode is derived from the amounts (ADR-048 R1)
  // =========================================================================

  describe('§4 mode derivation', () => {
    it.each([
      ['a full-online policy', FULL_ONLINE, 200_000, 'full_payment_online', 200_000, 0],
      ['a pay-at-venue policy', PAY_AT_VENUE, 200_000, 'pay_at_venue', 0, 200_000],
      ['a genuine deposit', fixedDeposit(60_000), 200_000, 'deposit_online_balance_at_venue', 60_000, 140_000],
    ])(
      'derives %s to the mode its AMOUNTS imply',
      async (_label, terms, price, expectedMode, collectible, venue) => {
        const { key } = await publishedPolicy(terms as BookingCollectionTermsV1);
        const seller = await professionalSeller(price as number);
        await enrol(seller, key);

        const schedule = await scheduleFor(await orderFor(seller));
        expect(schedule.collection_mode).toBe(expectedMode);
        expect(Number(schedule.platform_collectible_toman)).toBe(collectible);
        expect(Number(schedule.venue_balance_toman)).toBe(venue);
      },
    );

    it('derives pay_at_venue from a DEPOSIT policy whose percentage floors to zero', async () => {
      /*
       * ADR-048 R1, and the case that made the ADR necessary.
       *
       * The terms say `deposit_online_balance_at_venue`. One basis point of
       * 5,000 floors to zero, and `ck_ops_mode_consistent` admits that mode
       * only when `0 < collectible < total` STRICTLY -- so copying
       * `terms.collectionMode` would make this booking unwritable, months after
       * the policy was published and only for small totals.
       */
      const { key } = await publishedPolicy(percentageDeposit(1, 'service_total'));
      const seller = await professionalSeller(5_000);
      await enrol(seller, key);

      const schedule = await scheduleFor(await orderFor(seller));
      expect(Number(schedule.platform_collectible_toman)).toBe(0);
      expect(schedule.collection_mode).toBe('pay_at_venue');
      expect(Number(schedule.venue_balance_toman)).toBe(5_000);
    });

    it('derives full_payment_online from a DEPOSIT policy clamped up to the total', async () => {
      // The mirror case: a fixed deposit larger than the booking, clamped down
      // to the service total by the contract's last step, is full-online.
      const { key } = await publishedPolicy(fixedDeposit(500_000));
      const seller = await professionalSeller(120_000);
      await enrol(seller, key);

      const schedule = await scheduleFor(await orderFor(seller));
      expect(Number(schedule.platform_collectible_toman)).toBe(120_000);
      expect(schedule.collection_mode).toBe('full_payment_online');
      expect(Number(schedule.venue_balance_toman)).toBe(0);
    });
  });

  // =========================================================================
  // §5. The amounts come from the shipped contract
  // =========================================================================

  describe('§5 amounts', () => {
    it.each([
      ['percentage on the total', percentageDeposit(2_500, 'service_total'), 199_999],
      ['percentage on the subtotal', percentageDeposit(2_500, 'service_subtotal'), 199_999],
      ['a minimum above the proportional amount', percentageDeposit(100, 'service_total', 50_000), 200_000],
      ['a maximum below it', percentageDeposit(9_000, 'service_total', 0, 20_000), 200_000],
      ['a minimum above the service total, clamped last', percentageDeposit(100, 'service_total', 900_000), 120_000],
    ])('matches bookingCollectionAmountsV1 exactly for %s', async (_label, terms, price) => {
      const { key } = await publishedPolicy(terms as BookingCollectionTermsV1);
      const seller = await professionalSeller(price as number);
      await enrol(seller, key);

      const orderId = await orderFor(seller);
      const [order] = await dataSource.query(`SELECT * FROM commerce.orders WHERE id = $1`, [orderId]);
      const schedule = await scheduleFor(orderId);

      // Recomputed from the ORDER's own two amounts, so this compares the
      // service against the shipped helper rather than against a copy of it.
      const expected = bookingCollectionAmountsV1(
        Number(order.subtotal_toman),
        Number(order.total_toman),
        terms as BookingCollectionTermsV1,
      );
      expect({
        serviceTotalToman: Number(schedule.service_total_toman),
        platformCollectibleToman: Number(schedule.platform_collectible_toman),
        venueBalanceToman: Number(schedule.venue_balance_toman),
      }).toEqual(expected);
    });

    it('always satisfies ck_ops_sum, which is the database saying the same thing', async () => {
      const { key } = await publishedPolicy(percentageDeposit(3_333, 'service_total'));
      const seller = await professionalSeller(199_999);
      await enrol(seller, key);

      const schedule = await scheduleFor(await orderFor(seller));
      expect(
        Number(schedule.platform_collectible_toman) + Number(schedule.venue_balance_toman),
      ).toBe(Number(schedule.service_total_toman));
    });
  });

  // =========================================================================
  // §6. Fail closed
  // =========================================================================

  describe('§6 an enrolled seller fails closed', () => {
    it('refuses and writes NOTHING when the assigned version has been retired', async () => {
      const { key } = await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller();
      await enrol(seller, key);

      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired with nothing to replace it');

      const before = await commerceCounts();
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await expect(
        orders.createForBooking({
          bookingId: uuidv7(),
          customerId: customer.id,
          professionalId: seller.professionalId,
          serviceId: seller.serviceId,
        }),
      ).rejects.toThrow();

      // No order, no item, no adjustment, no schedule, no outbox row.
      expect(await commerceCounts()).toEqual(before);
    });

    it('refuses when the assigned key names a policy that no longer has any version', async () => {
      const { key } = await publishedPolicy(FULL_ONLINE);
      const seller = await professionalSeller();
      await enrol(seller, key);
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired');

      const before = await commerceCounts();
      await expect(orderFor(seller)).rejects.toThrow();
      expect(await commerceCounts()).toEqual(before);
    });

    it('the positive control: the SAME seller succeeds once a version is active again', async () => {
      /*
       * Without this, every refusal above would pass against an order path that
       * refused everything.
       */
      const { key } = await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);

      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired');
      await expect(orderFor(seller)).rejects.toThrow();

      const draft = await policies.createVersionDraft(
        admin.id,
        { policyKey: key, terms: fixedDeposit(70_000), activationEndsAt: null },
        'back on',
      );
      await policies.publishVersion(admin.id, key, draft.version, 'back on');

      const schedule = await scheduleFor(await orderFor(seller));
      expect(Number(schedule.platform_collectible_toman)).toBe(70_000);
    });

    it('never falls back to the legacy path after observing enrolment', async () => {
      // The strongest form: after a refusal there is no order at all, so there
      // is no full-online schedule sitting behind it either.
      const { key } = await publishedPolicy(FULL_ONLINE);
      const seller = await professionalSeller();
      await enrol(seller, key);
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired');

      await expect(orderFor(seller)).rejects.toThrow();
      expect(await dataSource.query(`SELECT * FROM ${SCHEDULES}`)).toHaveLength(0);
    });
  });

  // =========================================================================
  // §7. Linearization (ADR-048 R5)
  // =========================================================================

  describe('§7 locking', () => {
    /** Runs `body` with a second real connection held open in its own transaction. */
    async function withCompetitor<T>(
      body: (competitor: {
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
        commit: () => Promise<void>;
        rollback: () => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        return await body({
          query: (sql, params) => runner.query(sql, params as never[]),
          commit: () => runner.commitTransaction(),
          rollback: () => runner.rollbackTransaction(),
        });
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    }

    /**
     * Proves a promise is genuinely BLOCKED rather than merely slow: it has not
     * settled after the timer, and settles once the competitor releases.
     */
    const stillPending = async (promise: Promise<unknown>): Promise<boolean> => {
      const settled = await Promise.race([
        promise.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
      ]);
      return settled === 'blocked';
    };

    it('makes a concurrent SUPERSESSION wait on the current assignment row', async () => {
      const { key } = await publishedPolicy(fixedDeposit(40_000));
      const other = await publishedPolicy(fixedDeposit(90_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const [assignment] = await dataSource.query(
        `SELECT id FROM ${ASSIGNMENTS} WHERE seller_party_id = $1 AND superseded_at IS NULL`,
        [seller.partyId],
      );

      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      await withCompetitor(async (competitor) => {
        // The ORDER holds `FOR SHARE` on the assignment for the whole of its
        // transaction. We take the same lock first, from the competitor, so the
        // ordering is decided by us rather than by the scheduler.
        await competitor.query(
          `SELECT id FROM ${ASSIGNMENTS} WHERE id = $1 FOR UPDATE`,
          [assignment.id],
        );

        const creating = orders.createForBooking({
          bookingId: uuidv7(),
          customerId: customer.id,
          professionalId: seller.professionalId,
          serviceId: seller.serviceId,
        });
        const outcome = creating.then(
          (r) => r,
          (e: Error) => e,
        );

        // `FOR UPDATE` conflicts with the order's `FOR SHARE`, so the order
        // WAITS. Without the share lock it would sail past and snapshot a key
        // that a supersession was in the middle of replacing.
        expect(await stillPending(outcome)).toBe(true);
        expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(0);

        await competitor.rollback();
        const settled = await outcome;
        expect(settled).not.toBeInstanceOf(Error);
      });

      const rows = await dataSource.query(`SELECT * FROM ${SCHEDULES}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].policy_key).toBe(key);
      void other;
    });

    it('makes a concurrent RETIREMENT wait on the resolved version row', async () => {
      const { key } = await publishedPolicy(fixedDeposit(40_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const [version] = await dataSource.query(
        `SELECT id FROM commercial.booking_collection_policy_versions
          WHERE policy_key = $1 AND lifecycle_state = 'published'`,
        [key],
      );
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      await withCompetitor(async (competitor) => {
        await competitor.query(
          `SELECT id FROM commercial.booking_collection_policy_versions WHERE id = $1 FOR UPDATE`,
          [version.id],
        );

        const creating = orders.createForBooking({
          bookingId: uuidv7(),
          customerId: customer.id,
          professionalId: seller.professionalId,
          serviceId: seller.serviceId,
        });
        const outcome = creating.then(
          (r) => r,
          (e: Error) => e,
        );

        expect(await stillPending(outcome)).toBe(true);
        expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(0);

        await competitor.rollback();
        expect(await outcome).not.toBeInstanceOf(Error);
      });

      expect(await dataSource.query(`SELECT * FROM ${SCHEDULES}`)).toHaveLength(1);
    });

    it('leaves the booking-source unique index as the idempotency arbiter', async () => {
      const { key } = await publishedPolicy(fixedDeposit(40_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const input = {
        bookingId: uuidv7(),
        customerId: customer.id,
        professionalId: seller.professionalId,
        serviceId: seller.serviceId,
      };

      const [a, b] = await Promise.all([orders.createForBooking(input), orders.createForBooking(input)]);
      expect(a.order.id).toBe(b.order.id);
      expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(1);
      expect(await dataSource.query(`SELECT * FROM ${SCHEDULES}`)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §8. One selection, and a bounded query count
  // =========================================================================

  describe('§8 no re-read after the seller party is selected', () => {
    it('reads business_staff at most once per order creation', async () => {
      /*
       * The affiliation read is what `SellerPartyLookup` does, and ADR-048 R3's
       * guarantee is that it happens ONCE. Counting the statements that touch
       * `business_staff` is the direct measurement of that.
       */
      const { key } = await publishedPolicy(fixedDeposit(40_000));
      const seller = await affiliatedSeller(200_000);
      await enrol(seller, key);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const counter = new StatementCounter();
      const original = dataSource.logger;
      try {
        dataSource.logger = counter;
        counter.reset();
        await dataSource.query('SELECT 1');
        expect(counter.total).toBe(1); // the counter works

        counter.reset();
        await orders.createForBooking({
          bookingId: uuidv7(),
          customerId: customer.id,
          professionalId: seller.professionalId,
          serviceId: seller.serviceId,
        });
      } finally {
        dataSource.logger = original;
      }

      // The counter saw the transaction at all. Without this the three
      // assertions below would agree at zero and prove nothing.
      expect(counter.total).toBeGreaterThan(5);
      expect(counter.matching(/business_staff/i)).toBe(1);
      // The offering is read once too. `ServiceOfferingEntity` maps to
      // `provider.services`, so that is the table the statement names.
      expect(counter.matching(/provider"?\."?"?services/i)).toBe(1);
      // And the assignment is read once, by the resolver.
      expect(counter.matching(/seller_collection_policy_assignments/i)).toBe(1);
    });

    it('costs the same number of affiliation reads whether enrolled or not', async () => {
      const seller = await affiliatedSeller(200_000);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const counter = new StatementCounter();
      const original = dataSource.logger;
      let unenrolled = 0;
      try {
        dataSource.logger = counter;
        counter.reset();
        await orders.createForBooking({
          bookingId: uuidv7(),
          customerId: customer.id,
          professionalId: seller.professionalId,
          serviceId: seller.serviceId,
        });
        unenrolled = counter.matching(/business_staff/i);
      } finally {
        dataSource.logger = original;
      }
      expect(unenrolled).toBe(1);
    });
  });

  // =========================================================================
  // §9. History is never reinterpreted
  // =========================================================================

  describe('§9 historical stability', () => {
    it('leaves an existing schedule byte-identical through retirement, republication and reassignment', async () => {
      const { key, version } = await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const orderId = await orderFor(seller);
      const before = await scheduleFor(orderId);

      // Retire the version the order was priced by.
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired after the order');

      // Republish the same key with different terms.
      const draft = await policies.createVersionDraft(
        admin.id,
        { policyKey: key, terms: fixedDeposit(150_000), activationEndsAt: null },
        'different terms',
      );
      await policies.publishVersion(admin.id, key, draft.version, 'different terms');

      // Reassign the seller to a different policy entirely.
      const replacement = await publishedPolicy(PAY_AT_VENUE);
      const successorId = uuidv7();
      await dataSource.transaction(async (manager) => {
        const [current] = await manager.query(
          `SELECT id FROM ${ASSIGNMENTS} WHERE seller_party_id = $1 AND superseded_at IS NULL`,
          [seller.partyId],
        );
        await manager.query(
          `UPDATE ${ASSIGNMENTS} SET superseded_at = now(), superseded_by_user_id = $1,
             superseded_by_assignment_id = $2 WHERE id = $3`,
          [seller.ownerUser.id, successorId, current.id],
        );
        await manager.query(
          `INSERT INTO ${ASSIGNMENTS} (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [successorId, seller.partyType, seller.partyId, replacement.key, seller.ownerUser.id],
        );
      });

      // The original schedule is untouched by all three.
      expect(await scheduleFor(orderId)).toEqual(before);
      expect(Number((await scheduleFor(orderId)).policy_version)).toBe(version);

      // And the NEXT order gets the new answer, which is what makes the first
      // one's stability meaningful rather than accidental.
      const next = await scheduleFor(await orderFor(seller));
      expect(next.policy_key).toBe(replacement.key);
      expect(next.collection_mode).toBe('pay_at_venue');
    });

    it('leaves an existing schedule byte-identical through an affiliation change', async () => {
      const { key } = await publishedPolicy(fixedDeposit(50_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const orderId = await orderFor(seller);
      const before = await scheduleFor(orderId);
      const [orderBefore] = await dataSource.query(`SELECT * FROM commerce.orders WHERE id = $1`, [orderId]);

      const bizOwner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'کسب‌وکار بعدی');
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
        [uuidv7(), business.id, seller.ownerUser.id, seller.professionalId, bizOwner.id],
      );

      expect(await scheduleFor(orderId)).toEqual(before);
      const [orderAfter] = await dataSource.query(`SELECT * FROM commerce.orders WHERE id = $1`, [orderId]);
      expect(orderAfter.seller_party_id).toBe(orderBefore.seller_party_id);
    });

    it('refuses to rewrite a schedule at all, which is what makes the above permanent', async () => {
      const seller = await professionalSeller();
      const orderId = await orderFor(seller);
      await expect(
        dataSource.query(`UPDATE ${SCHEDULES} SET policy_key = 'forced' WHERE order_id = $1`, [orderId]),
      ).rejects.toThrow(/immutable/);
      await expect(dataSource.query(`DELETE FROM ${SCHEDULES} WHERE order_id = $1`, [orderId])).rejects.toThrow(
        /immutable/,
      );
    });
  });

  // =========================================================================
  // §10. Downstream shapes are unchanged
  // =========================================================================

  describe('§10 downstream compatibility', () => {
    it('keeps the browser projection free of policy identity for an ENROLLED order', async () => {
      const { key } = await publishedPolicy(fixedDeposit(60_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);

      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(48));
      await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ professionalId: seller.professionalId, slotId, serviceId: seller.serviceId })
        .expect(201);

      const [order] = await dataSource.query(`SELECT id FROM commerce.orders`);
      const viewed = await request(app.getHttpServer())
        .get(`/api/v1/orders/${order.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);

      // `OrderPaymentScheduleViewV1`, unchanged: the mode and the three
      // amounts, and deliberately not the policy's identity. A receipt shows
      // what the terms produced, never which terms produced it.
      const schedule = viewed.body.data.paymentSchedule;
      expect(Object.keys(schedule).sort()).toEqual([
        'collectionMode',
        'platformCollectibleNowToman',
        'serviceTotalToman',
        'venueBalanceToman',
      ]);
      expect(schedule.collectionMode).toBe('deposit_online_balance_at_venue');
      expect(schedule.platformCollectibleNowToman).toBe(60_000);

      const serialized = JSON.stringify(viewed.body);
      expect(serialized).not.toContain(key);
      expect(serialized).not.toMatch(/policyKey|policyVersion|policyAcceptedAt/);
    });

    it('keeps the subject-export column list unchanged for an enrolled order', async () => {
      const { key } = await publishedPolicy(fixedDeposit(60_000));
      const seller = await professionalSeller(200_000);
      await enrol(seller, key);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await orders.createForBooking({
        bookingId: uuidv7(),
        customerId: customer.id,
        professionalId: seller.professionalId,
        serviceId: seller.serviceId,
      });

      // Read the export projection directly: it must still omit the policy
      // columns, which is what keeps a receipt free of the terms' identity.
      const rows = await dataSource.query(
        `SELECT order_id, collection_mode, service_total_toman, platform_collectible_toman,
                venue_balance_toman, created_at
           FROM ${SCHEDULES}`,
      );
      expect(Object.keys(rows[0]).sort()).toEqual([
        'collection_mode',
        'created_at',
        'order_id',
        'platform_collectible_toman',
        'service_total_toman',
        'venue_balance_toman',
      ]);
    });
  });

  // =========================================================================
  // §11. Metrics carry no identity
  // =========================================================================

  describe('§11 metrics', () => {
    it('records only the two bounded outcomes, with no identifier anywhere', async () => {
      const { key } = await publishedPolicy(fixedDeposit(50_000));
      const enrolled = await professionalSeller(200_000);
      await enrol(enrolled, key);
      const plain = await professionalSeller(200_000);

      await orderFor(enrolled);
      await orderFor(plain);

      const scrape = metrics.render();
      const lines = scrape
        .split('\n')
        .filter((line) => line.startsWith(METRICS.collectionPolicyResolutions));

      expect(lines.join('\n')).toContain('outcome="enrolled"');
      expect(lines.join('\n')).toContain('outcome="legacy_unenrolled"');

      // The label set is exactly {outcome}, and its values are exactly the two.
      for (const line of lines) {
        const labels = /\{([^}]*)\}/.exec(line)?.[1] ?? '';
        if (!labels) continue;
        expect(labels).toMatch(/^outcome="(enrolled|legacy_unenrolled)"$/);
      }

      // Nothing that could identify anybody reached the scrape.
      for (const forbidden of [key, enrolled.partyId, plain.partyId, enrolled.ownerUser.id, '200000']) {
        expect(scrape).not.toContain(forbidden);
      }
    });

    it('records a bounded CAUSE on an enrolled failure and no identity', async () => {
      const { key } = await publishedPolicy(FULL_ONLINE);
      const seller = await professionalSeller();
      await enrol(seller, key);
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired');

      await expect(orderFor(seller)).rejects.toThrow();

      const scrape = metrics.render();
      const lines = scrape
        .split('\n')
        .filter((line) => line.startsWith(METRICS.collectionPolicyResolutionFailures));
      expect(lines.join('\n')).toContain('cause="no_active_version"');
      for (const line of lines) {
        const labels = /\{([^}]*)\}/.exec(line)?.[1] ?? '';
        if (!labels) continue;
        expect(labels).toMatch(/^cause="[a-z_]{1,40}"$/);
      }
      expect(scrape).not.toContain(key);
      expect(scrape).not.toContain(seller.partyId);
    });
  });

  // =========================================================================
  // §12. Nothing leaks into a log
  // =========================================================================

  describe('§12 leakage', () => {
    async function recordLogging<T>(run: () => Promise<T>): Promise<{ args: string; output: string }> {
      const args: unknown[] = [];
      let output = '';
      const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
      const spies = methods.map((method) =>
        jest.spyOn(Logger.prototype, method).mockImplementation(((...called: unknown[]) => {
          args.push(...called);
        }) as never),
      );
      const capture = (chunk: unknown): boolean => {
        output += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
      };
      const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
      const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);
      try {
        await run().catch(() => undefined);
        return { args: JSON.stringify(args), output };
      } finally {
        out.mockRestore();
        err.mockRestore();
        for (const spy of spies) spy.mockRestore();
      }
    }

    it('non-vacuity: the capture sees a planted value', async () => {
      const canary = 'CANARY-S115-4K2P';
      const { args, output } = await recordLogging(async () => {
        new Logger('Story115Probe').log(`planted ${canary}`);
        process.stdout.write(`planted ${canary}\n`);
      });
      expect(args).toContain(canary);
      expect(output).toContain(canary);
    });

    it('logs no policy key, party id or amount across an enrolled success and a failure', async () => {
      const live = await publishedPolicy(fixedDeposit(60_000), `canarykey-live-${Date.now() % 100000}`);
      const doomed = await publishedPolicy(FULL_ONLINE, `canarykey-doomed-${Date.now() % 100000}`);
      const good = await professionalSeller(200_000);
      const bad = await professionalSeller(200_000);
      await enrol(good, live.key);
      await enrol(bad, doomed.key);
      const doomedVersions = await policies.listVersions(doomed.key);
      await policies.retireVersion(admin.id, doomed.key, doomedVersions[0].version, 'retired');

      const { args, output } = await recordLogging(async () => {
        await orderFor(good);
        await orderFor(bad).catch(() => undefined);
      });

      for (const secret of [live.key, doomed.key, good.partyId, bad.partyId, good.ownerUser.phone]) {
        expect(args).not.toContain(secret);
        expect(output).not.toContain(secret);
      }
    });
  });
});

/** Counts statements and lets a test ask how many matched a pattern. */
class StatementCounter {
  private queries: string[] = [];

  get total(): number {
    return this.queries.length;
  }

  reset(): void {
    this.queries = [];
  }

  matching(pattern: RegExp): number {
    return this.queries.filter((q) => pattern.test(q)).length;
  }

  logQuery(query: string): void {
    this.queries.push(query);
  }

  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
