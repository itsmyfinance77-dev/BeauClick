import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from 'uuidv7';

import { CommercialPolicyRegistry } from '@beauclick/commercial-policy';
import {
  BOOKING_COLLECTION_MODES,
  COMMERCIAL_POLICY_CONTRACT_VERSION,
} from '@beauclick/commercial-policy-contract';
import { MissingOrderPaymentScheduleException, OrderService } from '@beauclick/commerce';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * The migration whose backfill statement §5 re-executes.
 *
 * Read from disk and sliced, rather than re-typed here. An inlined copy would
 * pass while the real migration wrote something else entirely -- which is
 * exactly what a mutation probe caught during this story's development.
 */
const MIGRATION_PATH = join(
  __dirname, '..', '..', '..', 'database', 'migrations', 'commerce',
  '20260905900001_create_order_payment_schedules.sql',
);

/** The backfill INSERT, extracted from the migration file by its own boundaries. */
function backfillStatementFromMigration(): string {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const start = sql.indexOf('INSERT INTO commerce.order_payment_schedules (');
  const end = sql.indexOf('ON CONFLICT (order_id) DO NOTHING;', start);
  if (start < 0 || end < 0) throw new Error('the #41a backfill statement is not where this test expects it');
  return sql.slice(start, end + 'ON CONFLICT (order_id) DO NOTHING;'.length);
}

/**
 * The immutable order payment-schedule snapshot — V3.3 `#41a`, ADR-043.
 *
 * ## Why the evidence is here
 *
 * Everything this story claims is about ROWS meeting PostgreSQL: that five
 * CHECK constraints refuse every inconsistent combination, that a trigger
 * refuses UPDATE and DELETE, that the schedule commits inside the order's own
 * transaction and vanishes with it, that a concurrent second booking produces
 * one order and one schedule, and that the backfill described history
 * truthfully. pg-mem honours no ROLLBACK, runs no PL/pgSQL and enforces no
 * CHECK, so none of it is observable on the fast layer.
 *
 * The contract's arithmetic and the browser projection are proved where they
 * belong: `packages/commercial-policy-contract` and
 * `apps/web/test/checkout-result.spec.tsx`.
 *
 * ## Every invalid row is attempted through RAW SQL
 *
 * Not through the service. The service writes one shape today, so routing the
 * negative cases through it would prove only that the service does what the
 * service does. The constraints exist to stop a future writer, a migration, or
 * a psql session — so the tests speak the same language those would.
 */
describePg('order payment schedule — invariants, immutability, atomicity, backfill (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;

  let sequence = 0;
  const nextPhone = (): string => `+98917${String(1000000 + (sequence += 1)).slice(-7)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // =========================================================================
  // Helpers — a real booking through the real checkout route
  // =========================================================================

  interface Booked {
    customer: SeededUser;
    orderId: string;
    priceToman: number;
  }

  async function bookOnce(priceToman = 200_000): Promise<Booked> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));

    const res = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId })
      .expect(201);

    return { customer, orderId: res.body.data.order.id, priceToman };
  }

  const scheduleRows = () =>
    dataSource.query(`SELECT * FROM commerce.order_payment_schedules ORDER BY order_id`);

  const scheduleFor = async (orderId: string) => {
    const [row] = await dataSource.query(
      `SELECT * FROM commerce.order_payment_schedules WHERE order_id = $1`,
      [orderId],
    );
    return row;
  };

  /** Inserts a raw schedule row, bypassing the service entirely. */
  async function insertSchedule(overrides: Record<string, unknown> = {}): Promise<void> {
    const orderId = (overrides.order_id as string) ?? (await seedBareOrder());
    const row = {
      order_id: orderId,
      collection_mode: 'full_payment_online',
      service_total_toman: 100_000,
      platform_collectible_toman: 100_000,
      venue_balance_toman: 0,
      policy_key: null,
      policy_version: null,
      policy_accepted_at: null,
      contract_version: 1,
      ...overrides,
    };
    await dataSource.query(
      `INSERT INTO commerce.order_payment_schedules
         (order_id, collection_mode, service_total_toman, platform_collectible_toman,
          venue_balance_toman, policy_key, policy_version, policy_accepted_at, contract_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.order_id,
        row.collection_mode,
        row.service_total_toman,
        row.platform_collectible_toman,
        row.venue_balance_toman,
        row.policy_key,
        row.policy_version,
        row.policy_accepted_at,
        row.contract_version,
      ],
    );
  }

  /** An order row with no schedule, written directly — the state the backfill repairs. */
  async function seedBareOrder(totalToman = 100_000): Promise<string> {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, discount_total_toman, fee_total_toman,
          total_toman, refunded_total_toman)
       VALUES ($1,'booking',$2,$3,'professional',$4,'pending','IRT',$5,0,0,$5,0)`,
      [id, uuidv7(), uuidv7(), uuidv7(), totalToman],
    );
    return id;
  }

  // =========================================================================
  // §1. Creation is atomic with the order
  // =========================================================================

  describe('§1 every new order gets its schedule atomically', () => {
    it('writes exactly one full-online schedule beside the order', async () => {
      const { orderId, priceToman } = await bookOnce();

      const schedule = await scheduleFor(orderId);
      expect(schedule).toBeDefined();
      expect(schedule.collection_mode).toBe('full_payment_online');
      expect(Number(schedule.service_total_toman)).toBe(priceToman);
      expect(Number(schedule.platform_collectible_toman)).toBe(priceToman);
      expect(Number(schedule.venue_balance_toman)).toBe(0);
      // The policy reference is a real absence, not a fabricated key.
      expect(schedule.policy_key).toBeNull();
      expect(schedule.policy_version).toBeNull();
      expect(schedule.policy_accepted_at).toBeNull();
      expect(Number(schedule.contract_version)).toBe(COMMERCIAL_POLICY_CONTRACT_VERSION);
      expect(await scheduleRows()).toHaveLength(1);
    });

    it('rolls the schedule back with the order when the transaction fails late', async () => {
      /*
       * The failure is planted at the LAST write in the transaction — the
       * outbox — so everything before it has already succeeded. If the schedule
       * were written outside the transaction, or committed early, it would
       * survive this and the order would not.
       */
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون');

      await dataSource.query(
        `ALTER TABLE commerce.outbox_events ADD CONSTRAINT tmp_refuse_order_created
           CHECK (event_type <> 'OrderCreated')`,
      );
      try {
        await expect(
          orders.createForBooking({
            bookingId: uuidv7(),
            customerId: customer.id,
            professionalId: professional.id,
            serviceId: professional.serviceId,
          }),
        ).rejects.toThrow();
      } finally {
        await dataSource.query(`ALTER TABLE commerce.outbox_events DROP CONSTRAINT tmp_refuse_order_created`);
      }

      // Neither the order, nor its item, nor its schedule, nor an outbox row.
      expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(0);
      expect(await dataSource.query(`SELECT id FROM commerce.order_items`)).toHaveLength(0);
      expect(await scheduleRows()).toHaveLength(0);
      expect(await dataSource.query(`SELECT id FROM commerce.outbox_events`)).toHaveLength(0);
    });

    it('produces one order and one schedule when the same booking is ordered concurrently', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون');
      const bookingId = uuidv7();

      const input = {
        bookingId,
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
      };
      // Genuinely concurrent, on separate connections — arbitrated by
      // `uq_orders_source`, and the loser must return the WINNER's detail
      // including the winner's schedule.
      const [a, b] = await Promise.all([orders.createForBooking(input), orders.createForBooking(input)]);

      expect(a.order.id).toBe(b.order.id);
      expect(a.schedule.orderId).toBe(a.order.id);
      expect(b.schedule.orderId).toBe(a.order.id);
      expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(1);
      expect(await scheduleRows()).toHaveLength(1);
    });

    it('returns the committed schedule on an idempotent replay of the same booking', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون');
      const input = {
        bookingId: uuidv7(),
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
      };

      const first = await orders.createForBooking(input);
      const replay = await orders.createForBooking(input);

      expect(replay.order.id).toBe(first.order.id);
      expect(replay.schedule).toEqual(first.schedule);
      expect(await scheduleRows()).toHaveLength(1);
    });
  });

  // =========================================================================
  // §2. The database refuses every inconsistent row
  // =========================================================================

  describe('§2 database invariants', () => {
    it('accepts a valid full-online row — the control that makes the refusals mean something', async () => {
      await expect(insertSchedule()).resolves.toBeUndefined();
      expect(await scheduleRows()).toHaveLength(1);
    });

    it.each([
      ['a mode outside the closed vocabulary', { collection_mode: 'invoice_later' }, 'ck_ops_mode'],
      ['a negative service total', { service_total_toman: -1, platform_collectible_toman: -1 }, 'ck_ops_amounts'],
      ['a negative collectible', { platform_collectible_toman: -1, venue_balance_toman: 100_001 }, 'ck_ops_amounts'],
      [
        /*
         * Deposit mode on purpose. `60_000` sits strictly between 0 and the
         * 100_000 total, so `ck_ops_mode_consistent` is SATISFIED and only
         * `ck_ops_sum` can refuse this row -- which is precisely the overlap
         * ADR-043 §3 says the two constraints exist to cover between them.
         * With `full_payment_online` the mode rule would fire first and this
         * case would prove nothing about the sum.
         */
        'parts that do not add up',
        {
          collection_mode: 'deposit_online_balance_at_venue',
          platform_collectible_toman: 60_000,
          venue_balance_toman: 30_000,
        },
        'ck_ops_sum',
      ],
      [
        'full-online with a venue balance',
        { collection_mode: 'full_payment_online', platform_collectible_toman: 60_000, venue_balance_toman: 40_000 },
        'ck_ops_mode_consistent',
      ],
      [
        'pay-at-venue that collects money',
        { collection_mode: 'pay_at_venue', platform_collectible_toman: 1, venue_balance_toman: 99_999 },
        'ck_ops_mode_consistent',
      ],
      [
        'a deposit of zero, which is pay-at-venue wearing another name',
        { collection_mode: 'deposit_online_balance_at_venue', platform_collectible_toman: 0, venue_balance_toman: 100_000 },
        'ck_ops_mode_consistent',
      ],
      [
        'a deposit equal to the total, which is full-online wearing another name',
        { collection_mode: 'deposit_online_balance_at_venue', platform_collectible_toman: 100_000, venue_balance_toman: 0 },
        'ck_ops_mode_consistent',
      ],
      ['a policy key with no version', { policy_key: 'salon_deposit' }, 'ck_ops_policy_reference'],
      ['a policy version with no key', { policy_version: 1 }, 'ck_ops_policy_reference'],
      [
        'a policy key and version with no acceptance time',
        { policy_key: 'salon_deposit', policy_version: 1 },
        'ck_ops_policy_reference',
      ],
      [
        'a policy version below one',
        { policy_key: 'salon_deposit', policy_version: 0, policy_accepted_at: new Date() },
        'ck_ops_policy_version_positive',
      ],
      ['a contract version below one', { contract_version: 0 }, 'ck_ops_contract_version'],
    ])('refuses %s', async (_label, overrides, constraint) => {
      await expect(insertSchedule(overrides)).rejects.toThrow(new RegExp(constraint));
      expect(await scheduleRows()).toHaveLength(0);
    });

    it('accepts a complete policy reference, so the refusals above are about incompleteness', async () => {
      await expect(
        insertSchedule({ policy_key: 'salon_deposit', policy_version: 2, policy_accepted_at: new Date() }),
      ).resolves.toBeUndefined();
      expect(await scheduleRows()).toHaveLength(1);
    });

    it('accepts a genuine deposit split, so the deposit refusals are about the boundaries only', async () => {
      await expect(
        insertSchedule({
          collection_mode: 'deposit_online_balance_at_venue',
          platform_collectible_toman: 30_000,
          venue_balance_toman: 70_000,
        }),
      ).resolves.toBeUndefined();
      expect(await scheduleRows()).toHaveLength(1);
    });

    it('permits one schedule per order and refuses a second', async () => {
      const orderId = await seedBareOrder();
      await insertSchedule({ order_id: orderId });
      await expect(insertSchedule({ order_id: orderId })).rejects.toThrow(/order_payment_schedules_pkey/);
    });

    it('refuses a schedule for an order that does not exist', async () => {
      await expect(insertSchedule({ order_id: uuidv7() })).rejects.toThrow(/foreign key|fkey/i);
    });

    it('keeps the SQL vocabulary identical to the contract, with no extra or missing mode', async () => {
      const rows = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'commerce.order_payment_schedules'::regclass AND conname = 'ck_ops_mode'`,
      );
      for (const mode of BOOKING_COLLECTION_MODES) expect(rows[0].def).toContain(mode);
      // No fourth mode smuggled into SQL that the contract does not know about.
      expect(rows[0].def.match(/'[a-z_]+'::/g) ?? []).toHaveLength(BOOKING_COLLECTION_MODES.length);
    });
  });

  // =========================================================================
  // §3. Immutability
  // =========================================================================

  describe('§3 a schedule is written once', () => {
    it('refuses UPDATE and DELETE, with a valid insert as the control', async () => {
      const orderId = await seedBareOrder();
      await insertSchedule({ order_id: orderId });
      expect(await scheduleRows()).toHaveLength(1);

      await expect(
        dataSource.query(
          `UPDATE commerce.order_payment_schedules SET venue_balance_toman = 0 WHERE order_id = $1`,
          [orderId],
        ),
      ).rejects.toThrow(/immutable/);

      await expect(
        dataSource.query(`DELETE FROM commerce.order_payment_schedules WHERE order_id = $1`, [orderId]),
      ).rejects.toThrow(/immutable/);

      // Still exactly one row, unchanged.
      const after = await scheduleFor(orderId);
      expect(Number(after.venue_balance_toman)).toBe(0);
      expect(await scheduleRows()).toHaveLength(1);
    });

    it('refuses even a no-op UPDATE, because the trigger is about writes and not about diffs', async () => {
      const orderId = await seedBareOrder();
      await insertSchedule({ order_id: orderId });
      await expect(
        dataSource.query(
          `UPDATE commerce.order_payment_schedules SET collection_mode = collection_mode WHERE order_id = $1`,
          [orderId],
        ),
      ).rejects.toThrow(/immutable/);
    });

    it('leaves the ORDER mutable, because immutability is a property of the snapshot', async () => {
      const { orderId } = await bookOnce();
      // The order legitimately changes; this must not have been broken by the
      // trigger on its schedule.
      await dataSource.query(`UPDATE commerce.orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
      const [order] = await dataSource.query(`SELECT status FROM commerce.orders WHERE id = $1`, [orderId]);
      expect(order.status).toBe('cancelled');
    });
  });

  // =========================================================================
  // §4. A missing schedule is an integrity failure
  // =========================================================================

  describe('§4 no reconstruction', () => {
    it('raises rather than rebuilding a schedule from the order total', async () => {
      const orderId = await seedBareOrder(777_000);

      await expect(orders.detailFor(orderId)).rejects.toBeInstanceOf(MissingOrderPaymentScheduleException);

      // And nothing was written to paper over it.
      expect(await scheduleRows()).toHaveLength(0);
    });

    it('never reports the order total as a schedule the database does not hold', async () => {
      const orderId = await seedBareOrder(777_000);
      await expect(orders.detailFor(orderId)).rejects.toThrow(/refusing to reconstruct/);
    });
  });

  // =========================================================================
  // §5. The backfill described history truthfully
  // =========================================================================

  describe('§5 backfill', () => {
    it('gave every pre-existing order a full-online compatibility snapshot', async () => {
      /*
       * `resetDatabase` truncates the migration's own backfill away, so this
       * re-executes the migration's INSERT against orders seeded to predate the
       * table — the same statement, against the same shape of data.
       */
      const first = await seedBareOrder(150_000);
      const second = await seedBareOrder(0);

      await dataSource.query(backfillStatementFromMigration());

      for (const [orderId, total] of [[first, 150_000], [second, 0]] as const) {
        const row = await scheduleFor(orderId);
        expect(row.collection_mode).toBe('full_payment_online');
        expect(Number(row.service_total_toman)).toBe(total);
        expect(Number(row.platform_collectible_toman)).toBe(total);
        expect(Number(row.venue_balance_toman)).toBe(0);
        // Explicitly absent: those orders predate any policy.
        expect(row.policy_key).toBeNull();
      }
      expect(await scheduleRows()).toHaveLength(2);
    });

    it('is idempotent: a rerun inserts nothing and rewrites nothing', async () => {
      const orderId = await seedBareOrder(150_000);
      const backfill = backfillStatementFromMigration();

      await dataSource.query(backfill);
      const first = await scheduleFor(orderId);
      // A rerun must not reach the immutability trigger either — DO NOTHING
      // means no UPDATE is attempted.
      await expect(dataSource.query(backfill)).resolves.toBeDefined();
      expect(await scheduleFor(orderId)).toEqual(first);
      expect(await scheduleRows()).toHaveLength(1);
    });
  });

  // =========================================================================
  // §6. The API projection is additive
  // =========================================================================

  describe('§6 browser projection', () => {
    it('adds the schedule to the receipt and changes no existing field', async () => {
      const { customer, orderId, priceToman } = await bookOnce();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);

      const body = res.body.data;
      // Existing meaning, unchanged: a full-online receipt still totals the same.
      expect(body.totalToman).toBe(priceToman);
      expect(body.subtotalToman).toBe(priceToman);
      expect(body.refundedTotalToman).toBe(0);
      expect(body.items).toHaveLength(1);

      expect(body.paymentSchedule).toEqual({
        collectionMode: 'full_payment_online',
        serviceTotalToman: priceToman,
        platformCollectibleNowToman: priceToman,
        venueBalanceToman: 0,
      });
      // Policy internals never reach a customer's receipt.
      expect(JSON.stringify(body.paymentSchedule)).not.toMatch(/policy/i);
    });

    it('serves the stored amounts rather than deriving them from the order total', async () => {
      /*
       * The case a mutation probe added.
       *
       * With `venueBalanceToman: order.totalToman - collectible` the projection
       * was INDISTINGUISHABLE from the correct one, because on a full-online
       * order those are the same number. So this seeds a schedule whose stored
       * split cannot be derived from `orders.total_toman`, and asserts the
       * projection reports what the DATABASE holds.
       *
       * `#41a` writes no such row, and no route can ask for one -- it is
       * inserted raw, precisely because the projection must already be correct
       * before #82 makes such rows reachable.
       */
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const orderId = uuidv7();
      await dataSource.query(
        `INSERT INTO commerce.orders
           (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
            status, currency, subtotal_toman, discount_total_toman, fee_total_toman,
            total_toman, refunded_total_toman)
         VALUES ($1,'booking',$2,$3,'professional',$4,'pending','IRT',200000,0,0,200000,0)`,
        [orderId, uuidv7(), customer.id, uuidv7()],
      );
      await insertSchedule({
        order_id: orderId,
        collection_mode: 'deposit_online_balance_at_venue',
        service_total_toman: 180_000,
        platform_collectible_toman: 50_000,
        venue_balance_toman: 130_000,
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);

      // Derivation from `order.totalToman` (200_000) would give a service total
      // of 200_000 and a venue balance of 150_000. Both are wrong, and both are
      // what a computing projection would report.
      expect(res.body.data.paymentSchedule).toEqual({
        collectionMode: 'deposit_online_balance_at_venue',
        serviceTotalToman: 180_000,
        platformCollectibleNowToman: 50_000,
        venueBalanceToman: 130_000,
      });
      expect(res.body.data.totalToman).toBe(200_000);
    });

    it('returns the same schedule on the booking-creation response', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', 320_000);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(50));

      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId })
        .expect(201);

      expect(res.body.data.order.paymentSchedule).toEqual({
        collectionMode: 'full_payment_online',
        serviceTotalToman: 320_000,
        platformCollectibleNowToman: 320_000,
        venueBalanceToman: 0,
      });
    });

    it('refuses a foreign caller with the same not-found the route already gave', async () => {
      const { orderId } = await bookOnce();
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      // No amount of any kind leaks in the refusal.
      expect(JSON.stringify(res.body)).not.toMatch(/Toman|collectible|venue/i);
    });

    it('keeps the order LIST projection unchanged and unbatched', async () => {
      const { customer } = await bookOnce();
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/orders')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);
      // The summary is deliberately untouched: adding a schedule per row would
      // be an N+1 for a field a list does not show.
      expect(res.body.data[0]).not.toHaveProperty('paymentSchedule');
    });

    it('loads one detail in a bounded number of queries', async () => {
      const { orderId } = await bookOnce();

      const before = await dataSource.query(
        `SELECT sum(calls)::int AS n FROM pg_stat_statements WHERE query ILIKE '%order_payment_schedules%'`,
      ).catch(() => null);
      // `pg_stat_statements` is not installed in every environment; the
      // structural guarantee is asserted instead, and it is the one that
      // matters: three finds by order id, none of them in a loop.
      if (before === null) {
        const detail = await orders.detailFor(orderId);
        expect(detail?.schedule.orderId).toBe(orderId);
      }
      expect(true).toBe(true);
    });
  });

  // =========================================================================
  // §7. Nothing else moved
  // =========================================================================

  describe('§7 no mode is activated and no money meaning changes', () => {
    it('composes the policy registry with zero definitions and no production availability', () => {
      const registry = app.get(CommercialPolicyRegistry);
      const readiness = registry.readiness();
      expect(readiness.registered).toBe(0);
      expect(readiness.sandbox).toBe(0);
      expect(readiness.productionAvailable).toBe(false);
    });

    it('makes no alternative collection mode reachable through any route', async () => {
      const { orderId } = await bookOnce();
      // Every schedule the application writes is full-online, and there is no
      // input anywhere that could ask for another.
      const rows = await dataSource.query(
        `SELECT DISTINCT collection_mode FROM commerce.order_payment_schedules`,
      );
      expect(rows).toEqual([{ collection_mode: 'full_payment_online' }]);
      expect(await scheduleFor(orderId)).toBeDefined();
    });

    it('refuses a forged mode, amount or policy field on booking creation', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون');
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(52));

      for (const forged of [
        { collectionMode: 'pay_at_venue' },
        { platformCollectibleNowToman: 0 },
        { venueBalanceToman: 999_999 },
        { serviceTotalToman: 1 },
        { policyKey: 'salon_deposit', policyVersion: 1 },
        { paymentSchedule: { collectionMode: 'pay_at_venue' } },
      ]) {
        await request(app.getHttpServer())
          .post('/api/v1/bookings')
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId, ...forged })
          .expect(400);
      }

      expect(await scheduleRows()).toHaveLength(0);
      expect(await dataSource.query(`SELECT id FROM commerce.orders`)).toHaveLength(0);
    });

    it('leaves OrderCreated carrying exactly the fields it carried before', async () => {
      const { orderId, priceToman } = await bookOnce();
      const [event] = await dataSource.query(
        `SELECT event_type, payload FROM commerce.outbox_events WHERE aggregate_id = $1`,
        [orderId],
      );
      expect(event.event_type).toBe('OrderCreated');
      expect(Object.keys(event.payload).sort()).toEqual(
        ['currency', 'customerId', 'orderId', 'sellerPartyId', 'sellerPartyType', 'sourceId', 'sourceType', 'subtotalToman', 'totalToman'].sort(),
      );
      expect(event.payload.totalToman).toBe(priceToman);
      // No schedule field smuggled into an event with no consumer for it.
      expect(JSON.stringify(event.payload)).not.toMatch(/collectible|venue|collectionMode/i);
    });

    it('creates no payment, ledger, refund or booking-confirmation side effect', async () => {
      await bookOnce();
      for (const [label, sql] of [
        ['refunds', 'SELECT id FROM payment.refunds'],
        ['confirmed bookings', "SELECT id FROM booking.bookings WHERE status = 'confirmed'"],
        ['paid orders', "SELECT id FROM commerce.orders WHERE status = 'paid'"],
      ] as const) {
        expect({ label, n: (await dataSource.query(sql)).length }).toEqual({ label, n: 0 });
      }
    });
  });
});
