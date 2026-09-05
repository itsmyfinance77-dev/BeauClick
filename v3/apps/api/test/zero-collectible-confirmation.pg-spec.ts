import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from 'uuidv7';

import { BookingService } from '@beauclick/booking';
import { OrderService, ZERO_COLLECTIBLE_CONFIRMATION_HOOK } from '@beauclick/commerce';

import { PaymentIntentNotFoundException } from '@beauclick/payment';

import { BookingCancelledRefundHandler } from '../src/events/financial-projection.handlers';

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

const MIGRATION_PATH = join(
  __dirname, '..', '..', '..', 'database', 'migrations', 'commerce',
  '20260905900002_add_online_collection_not_required_status.sql',
);

/**
 * Zero-online-collection confirmation — V3.3 #81 (`#41b`), ADR-044,
 * `V33-DEC-023`.
 *
 * ## Why this suite exists at the real-PostgreSQL layer
 *
 * Every claim #81 makes is about what a database does under contention:
 * that the order transition is a compare-and-swap only one caller can win,
 * that a `CHECK` constraint refuses an unknown status and accepts a
 * thirty-character one, that a positive collectible is *structurally* unable to
 * take the transition, and that a failure inside the confirmation transaction
 * leaves no trace of any of the three mutations.
 *
 * pg-mem enforces no CHECK, honours no ROLLBACK and runs no PL/pgSQL, so none
 * of that is observable on the fast layer. The ORDERING of the three mutations
 * is proved on the fast layer instead, where it is directly observable
 * (`apps/api/src/checkout/zero-collectible-checkout.spec.ts`).
 *
 * ## Every negative has a positive control
 *
 * A test that asserts "no payment intent exists" passes trivially if the
 * checkout never ran. So each such assertion is paired with the same query
 * against a positive-collectible booking, in the same suite, against the same
 * tables — and that one must find a row.
 */
describePg('zero-collectible confirmation (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;
  let bookings: BookingService;

  let sequence = 0;
  const nextPhone = (): string => `+98916${String(1000000 + (sequence += 1)).slice(-7)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /** The checkout response shape this suite reads, named rather than `any`. */
  interface CheckoutBody {
    booking: { id: string; status: string } | null;
    order: { id: string; status: string; totalToman: number };
    payment: { intentId: string | null; redirectUrl: string | null };
  }

  interface Booked {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
    body: CheckoutBody;
  }

  /**
   * A booking through the real public checkout route.
   *
   * `priceToman = 0` is the zero-collectible case that IS reachable today: the
   * schedule comes out `full_payment_online` with service total, collectible and
   * venue balance all zero, which `ck_ops_mode_consistent` accepts.
   */
  async function bookThroughRoute(priceToman: number): Promise<Booked> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));

    const res = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId })
      .expect(201);

    return {
      customer,
      bookingId: res.body.data.booking.id,
      orderId: res.body.data.order.id,
      body: res.body.data,
    };
  }

  const orderRow = async (orderId: string) => {
    const [row] = await dataSource.query('SELECT * FROM commerce.orders WHERE id = $1', [orderId]);
    return row;
  };

  const bookingRow = async (bookingId: string) => {
    const [row] = await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]);
    return row;
  };

  const countRows = async (sql: string, params: unknown[] = []): Promise<number> => {
    const [row] = await dataSource.query(sql, params);
    return Number(row?.count ?? 0);
  };

  const paymentIntentCount = (orderId: string) =>
    countRows('SELECT count(*) FROM payment.payment_intents WHERE order_id = $1', [orderId]);

  const paymentAttemptCount = (orderId: string) =>
    countRows(
      `SELECT count(*) FROM payment.payment_attempts a
         JOIN payment.payment_intents i ON i.id = a.payment_intent_id
        WHERE i.order_id = $1`,
      [orderId],
    );

  const commerceEventTypes = async (orderId: string): Promise<string[]> => {
    const rows = await dataSource.query(
      'SELECT event_type FROM commerce.outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [orderId],
    );
    return rows.map((r: { event_type: string }) => r.event_type);
  };

  const bookingEventTypes = async (bookingId: string): Promise<string[]> => {
    const rows = await dataSource.query(
      'SELECT event_type FROM booking.outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [bookingId],
    );
    return rows.map((r: { event_type: string }) => r.event_type);
  };

  /**
   * A `pay_at_venue` schedule with a NON-ZERO service price.
   *
   * This is the case the public API cannot yet produce — selecting a collection
   * mode is #82/#83's work, and #81 must not invent a payment-mode selector to
   * make its own test easier. So the row is planted directly, which is also the
   * honest shape: the constraint and the transition are what is under test, and
   * both speak SQL.
   *
   * The schedule is immutable, so the existing `full_payment_online` row is
   * removed with the trigger disabled — a test-fixture concession that is
   * explicitly NOT available to production code.
   */
  async function makePayAtVenue(orderId: string, serviceTotal: number): Promise<void> {
    await dataSource.query('ALTER TABLE commerce.order_payment_schedules DISABLE TRIGGER tg_order_payment_schedules_immutable');
    try {
      await dataSource.query('DELETE FROM commerce.order_payment_schedules WHERE order_id = $1', [orderId]);
    } finally {
      await dataSource.query('ALTER TABLE commerce.order_payment_schedules ENABLE TRIGGER tg_order_payment_schedules_immutable');
    }
    await dataSource.query(
      `INSERT INTO commerce.order_payment_schedules
         (order_id, collection_mode, service_total_toman, platform_collectible_toman, venue_balance_toman, contract_version)
       VALUES ($1, 'pay_at_venue', $2, 0, $2, 1)`,
      [orderId, serviceTotal],
    );
  }

  // =========================================================================
  // 1. The public zero-collectible checkout
  // =========================================================================

  describe('a zero-collectible checkout confirms, and creates nothing money-shaped', () => {
    it('confirms the booking and leaves the order online_collection_not_required', async () => {
      const booked = await bookThroughRoute(0);

      expect((await orderRow(booked.orderId)).status).toBe('online_collection_not_required');
      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
    });

    it('returns both payment keys, both null', async () => {
      const booked = await bookThroughRoute(0);

      expect(booked.body.payment).toEqual({ intentId: null, redirectUrl: null });
      expect(Object.keys(booked.body.payment).sort()).toEqual(['intentId', 'redirectUrl']);
      expect(booked.body.order.status).toBe('online_collection_not_required');
      expect(booked.body.booking?.status).toBe('confirmed');
    });

    it('creates no payment intent, no attempt, and no financial or loyalty row', async () => {
      const booked = await bookThroughRoute(0);

      expect(await paymentIntentCount(booked.orderId)).toBe(0);
      expect(await paymentAttemptCount(booked.orderId)).toBe(0);
      expect(await countRows('SELECT count(*) FROM payment.refunds')).toBe(0);
      expect(await countRows('SELECT count(*) FROM loyalty.points_entries')).toBe(0);

      /*
       * The financial ledger is proved by absence of its only trigger rather
       * than by a direct count: `financial.ledger_entries` lives on the
       * append-only financial connection (ADR-017) and this suite's app role
       * deliberately cannot read it. The ledger is written by the `OrderPaid`
       * consumer and by nothing else, so no `OrderPaid` is exactly the claim.
       */
      expect(await commerceEventTypes(booked.orderId)).not.toContain('OrderPaid');
    });

    it('emits no new commerce event for the transition — OrderCreated and nothing else', async () => {
      const booked = await bookThroughRoute(0);

      expect(await commerceEventTypes(booked.orderId)).toEqual(['OrderCreated']);
    });

    it('emits exactly the existing BookingConfirmed through booking’s own outbox', async () => {
      const booked = await bookThroughRoute(0);

      const types = await bookingEventTypes(booked.bookingId);
      expect(types).toContain('BookingConfirmed');
      expect(types.filter((t) => t === 'BookingConfirmed')).toHaveLength(1);
      // No invented sibling.
      expect(types.some((t) => /Collection|Collectible|ZeroCollect/i.test(t))).toBe(false);
    });

    /**
     * The positive control for all four negatives above.
     *
     * Same suite, same tables, same queries — one number changed. If the
     * zero-collectible assertions were passing because the checkout silently
     * failed, this would find no intent either.
     */
    it('control: a positive-collectible checkout DOES create an intent and stays pending', async () => {
      const booked = await bookThroughRoute(150_000);

      expect(await paymentIntentCount(booked.orderId)).toBe(1);
      expect((await orderRow(booked.orderId)).status).toBe('pending');
      expect((await bookingRow(booked.bookingId)).status).toBe('pending');
      expect(booked.body.payment.intentId).not.toBeNull();
      expect(await bookingEventTypes(booked.bookingId)).not.toContain('BookingConfirmed');
    });
  });

  // =========================================================================
  // 2. The trigger is the schedule, not the total
  // =========================================================================

  describe('the decision reads the schedule, never the order total', () => {
    it('transitions a pay_at_venue order whose total is NON-ZERO', async () => {
      const booked = await bookThroughRoute(150_000);
      await makePayAtVenue(booked.orderId, 150_000);

      const outcome = await dataSource.transaction((m) => orders.confirmNoOnlineCollection(booked.orderId, m));

      expect(outcome).toEqual({ outcome: 'transitioned' });
      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('online_collection_not_required');
      // The total is untouched and still non-zero: this is exactly the case a
      // `total_toman === 0` branch would have refused.
      expect(Number(row.total_toman)).toBe(150_000);
    });

    it('refuses an order whose collectible is positive, even though it is pending', async () => {
      const booked = await bookThroughRoute(150_000);

      const outcome = await dataSource.transaction((m) => orders.confirmNoOnlineCollection(booked.orderId, m));

      expect(outcome).toEqual({ outcome: 'ineligible', reason: 'positive_collectible' });
      expect((await orderRow(booked.orderId)).status).toBe('pending');
    });

    it('the refusal is in the statement: raw SQL with the same predicate affects no row', async () => {
      const booked = await bookThroughRoute(150_000);

      // The service could be bypassed; the WHERE clause cannot. This is the
      // database-supported boundary the service boundary above mirrors.
      const raw = await dataSource.query(
        `UPDATE commerce.orders o SET status = 'online_collection_not_required'
          WHERE o.id = $1 AND o.status = 'pending'
            AND EXISTS (SELECT 1 FROM commerce.order_payment_schedules s
                         WHERE s.order_id = o.id AND s.platform_collectible_toman = 0)
       RETURNING o.id`,
        [booked.orderId],
      );
      expect(raw[0]).toHaveLength(0);
      expect((await orderRow(booked.orderId)).status).toBe('pending');
    });
  });

  // =========================================================================
  // 3. Concurrency, replay, rollback
  // =========================================================================

  describe('concurrency and replay', () => {
    it('N concurrent transitions produce exactly one winner', async () => {
      const booked = await bookThroughRoute(150_000);
      await makePayAtVenue(booked.orderId, 150_000);
      // Put the order back to pending so the race starts from the real state.
      await dataSource.query('UPDATE commerce.orders SET status = $2 WHERE id = $1', [booked.orderId, 'pending']);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          dataSource.transaction((m) => orders.confirmNoOnlineCollection(booked.orderId, m)),
        ),
      );

      expect(outcomes.filter((o) => o.outcome === 'transitioned')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'already')).toHaveLength(5);
      expect((await orderRow(booked.orderId)).status).toBe('online_collection_not_required');
    });

    it('concurrent checkouts on one idempotency key produce one booking, one order, one confirmation', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص همزمان', 0);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72));
      const key = uuidv7();

      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app.getHttpServer())
            .post('/api/v1/bookings')
            .set('Authorization', `Bearer ${customer.accessToken}`)
            .set('Idempotency-Key', key)
            .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId }),
        ),
      );

      const accepted = responses.filter((r) => r.status === 201);
      expect(accepted.length).toBeGreaterThanOrEqual(1);

      const bookingIds = new Set(accepted.map((r) => r.body.data.booking.id));
      expect(bookingIds.size).toBe(1);

      const bookingId = [...bookingIds][0];
      const orderCount = await countRows(
        `SELECT count(*) FROM commerce.orders WHERE source_type = 'booking' AND source_id = $1`,
        [bookingId],
      );
      expect(orderCount).toBe(1);

      const confirmed = (await bookingEventTypes(bookingId)).filter((t) => t === 'BookingConfirmed');
      expect(confirmed).toHaveLength(1);

      const history = await countRows(
        `SELECT count(*) FROM booking.booking_history WHERE booking_id = $1 AND to_status = 'confirmed'`,
        [bookingId],
      );
      expect(history).toBe(1);

      // Every successful caller got a compatible, authoritative answer.
      for (const r of accepted) {
        expect(r.body.data.order.status).toBe('online_collection_not_required');
        expect(r.body.data.payment).toEqual({ intentId: null, redirectUrl: null });
      }
    });

    it('a replayed checkout does not duplicate any fact', async () => {
      const booked = await bookThroughRoute(0);

      const before = await bookingEventTypes(booked.bookingId);

      const again = await dataSource.transaction((m) =>
        orders.confirmNoOnlineCollection(booked.orderId, m),
      );
      expect(again).toEqual({ outcome: 'already' });

      expect(await bookingEventTypes(booked.bookingId)).toEqual(before);
      expect(await commerceEventTypes(booked.orderId)).toEqual(['OrderCreated']);
    });

    it('a rolled-back confirmation transaction leaves the order pending and creates nothing', async () => {
      const booked = await bookThroughRoute(150_000);
      await makePayAtVenue(booked.orderId, 150_000);

      await expect(
        dataSource.transaction(async (m) => {
          const outcome = await orders.confirmNoOnlineCollection(booked.orderId, m);
          expect(outcome).toEqual({ outcome: 'transitioned' });
          await bookings.confirm(booked.bookingId, { type: 'system', id: null }, m);
          throw new Error('planted failure after all three mutations');
        }),
      ).rejects.toThrow('planted failure');

      // ROLLBACK is real here, unlike on pg-mem: all three mutations vanish.
      expect((await orderRow(booked.orderId)).status).toBe('pending');
      expect((await bookingRow(booked.bookingId)).status).toBe('pending');
      expect(await bookingEventTypes(booked.bookingId)).not.toContain('BookingConfirmed');
      expect(await countRows('SELECT count(*) FROM payment.refunds')).toBe(0);
    });
  });

  // =========================================================================
  // 4. Cancellation and expiry
  // =========================================================================

  describe('cancellation of a never-collected order', () => {
    it('cancels without any provider call or refund', async () => {
      const booked = await bookThroughRoute(0);
      expect((await orderRow(booked.orderId)).status).toBe('online_collection_not_required');

      const cancelled = await orders.cancel(booked.orderId, 'test:no-collection');
      expect(cancelled).toBe(true);

      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('cancelled');
      expect(row.cancelled_at).not.toBeNull();
      expect(await countRows('SELECT count(*) FROM payment.refunds')).toBe(0);
      expect(await paymentIntentCount(booked.orderId)).toBe(0);
    });

    /**
     * The order here has a NON-ZERO total and a zero collectible — the
     * `pay_at_venue` shape — and that is the whole point of the fixture.
     *
     * A zero-priced order would make this test vacuous: `remainingRefundable`
     * would be `0 - 0 = 0`, so the handler would issue no refund whether or not
     * `online_collection_not_required` is classified as never-collected. With a
     * 150,000 venue balance the two behaviours diverge, and removing the status
     * from `NEVER_COLLECTED_STATUSES` makes this test fail — which is exactly
     * the defect the classification exists to prevent.
     */
    it('cancelling a NON-ZERO-total never-collected booking issues no refund', async () => {
      const booked = await bookThroughRoute(150_000);
      await makePayAtVenue(booked.orderId, 150_000);
      await dataSource.transaction((m) => orders.confirmNoOnlineCollection(booked.orderId, m));
      expect((await orderRow(booked.orderId)).status).toBe('online_collection_not_required');

      const handler = app.get(BookingCancelledRefundHandler);
      await handler.handle({ payload: { bookingId: booked.bookingId } } as never);

      expect(await countRows('SELECT count(*) FROM payment.refunds')).toBe(0);
      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('cancelled');
      // The venue balance is still recorded in full: cancelling did not pretend
      // the money was never owed, only that BeauClick never held it.
      expect(Number(row.total_toman)).toBe(150_000);
      expect(Number(row.refunded_total_toman)).toBe(0);
    });

    /**
     * The control that makes the zero above a decision rather than an inert
     * code path: the same handler, the same amount, one status changed, and it
     * takes the OTHER branch.
     *
     * It asserts the branch was entered rather than that a refund row appeared,
     * and the distinction is deliberate. The fixture marks the order `paid` by
     * raw SQL without a succeeded payment intent — a state the real payment path
     * cannot produce — so `PaymentService.refund` refuses with
     * `PaymentIntentNotFoundException`. That refusal comes from *inside* the
     * refund call, which is precisely the evidence wanted: a `paid` order
     * reaches the provider, and an `online_collection_not_required` one never
     * does. Asserting a refund row instead would have required faking a whole
     * gateway success, and would have proved less.
     */
    it('control: the same handler DOES reach the refund path for a paid order', async () => {
      const booked = await bookThroughRoute(150_000);
      await dataSource.query('UPDATE commerce.orders SET status = $2, paid_at = now() WHERE id = $1', [
        booked.orderId,
        'paid',
      ]);

      const handler = app.get(BookingCancelledRefundHandler);

      await expect(handler.handle({ payload: { bookingId: booked.bookingId } } as never)).rejects.toThrow(
        PaymentIntentNotFoundException,
      );

      // And it did NOT quietly cancel it the way the never-collected branch does.
      expect((await orderRow(booked.orderId)).status).toBe('paid');
    });

    it('control: cancel() still refuses a paid order, so the widening did not become a hole', async () => {
      const booked = await bookThroughRoute(150_000);
      await dataSource.query('UPDATE commerce.orders SET status = $2, paid_at = now() WHERE id = $1', [
        booked.orderId,
        'paid',
      ]);

      expect(await orders.cancel(booked.orderId, 'test:should-refuse')).toBe(false);
      expect((await orderRow(booked.orderId)).status).toBe('paid');
    });

    it('two concurrent cancellations produce exactly one OrderCancelled', async () => {
      const booked = await bookThroughRoute(0);

      const results = await Promise.all(
        Array.from({ length: 4 }, () => orders.cancel(booked.orderId, 'test:race')),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      const cancelledEvents = (await commerceEventTypes(booked.orderId)).filter((t) => t === 'OrderCancelled');
      expect(cancelledEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // 5. The migration and the constraint
  // =========================================================================

  describe('schema', () => {
    it('the status column is wide enough for the 30-character literal', async () => {
      const [col] = await dataSource.query(
        `SELECT character_maximum_length AS len FROM information_schema.columns
          WHERE table_schema = 'commerce' AND table_name = 'orders' AND column_name = 'status'`,
      );
      expect(Number(col.len)).toBeGreaterThanOrEqual(32);
      expect('online_collection_not_required'.length).toBe(30);
    });

    it('ck_orders_status names all six statuses and no more', async () => {
      const [row] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_orders_status'`,
      );
      for (const status of [
        'pending',
        'paid',
        'partially_refunded',
        'refunded',
        'cancelled',
        'online_collection_not_required',
      ]) {
        expect(row.def).toContain(status);
      }
    });

    it('the constraint refuses an unknown status', async () => {
      const booked = await bookThroughRoute(150_000);

      await expect(
        dataSource.query('UPDATE commerce.orders SET status = $2 WHERE id = $1', [
          booked.orderId,
          'definitely_not_a_status',
        ]),
      ).rejects.toThrow(/ck_orders_status/);
    });

    it('the migration file itself widens the column and rebuilds the allowlist', () => {
      const sql = readFileSync(MIGRATION_PATH, 'utf8');
      // Read from disk rather than retyped: an inlined copy would pass while
      // the real migration did something else, which is the failure mode the
      // #41a suite already caught once.
      expect(sql).toContain('ALTER COLUMN status TYPE VARCHAR(32)');
      expect(sql).toContain('DROP CONSTRAINT ck_orders_status');
      expect(sql).toContain("'online_collection_not_required'");
      expect(sql).not.toContain('DROP TABLE');
    });
  });

  // =========================================================================
  // 6. The hook is mandatory
  // =========================================================================

  describe('the entitlement hook', () => {
    it('is bound in the running application', () => {
      expect(app.get(ZERO_COLLECTIBLE_CONFIRMATION_HOOK)).toBeDefined();
    });

    /**
     * The mandatory-binding proof, and it is deliberately paired.
     *
     * An earlier version of this test compiled a module containing only
     * `CheckoutService` and asserted that it threw. It did throw — for every
     * missing dependency at once — so it passed just as happily when the hook
     * was made `@Optional()`. A mutation probe caught that: the test was
     * vacuous, and a vacuous test of a mandatory money seam is worse than none.
     *
     * The pair below is attributable. Both cases provide every other
     * dependency; they differ in exactly one provider, and they must give
     * opposite answers.
     */
    it('a composition missing ONLY the hook fails to construct', async () => {
      const { Test } = await import('@nestjs/testing');
      const { CheckoutService } = await import('../src/checkout/checkout.service');
      const { OrderService } = await import('@beauclick/commerce');
      const { BookingService } = await import('@beauclick/booking');
      const { PaymentService } = await import('@beauclick/payment');
      const { OutboxRelay } = await import('@beauclick/events');
      const { DataSource } = await import('typeorm');

      const others = [
        { provide: DataSource, useValue: {} },
        { provide: BookingService, useValue: {} },
        { provide: OrderService, useValue: {} },
        { provide: PaymentService, useValue: {} },
        { provide: OutboxRelay, useValue: {} },
      ];

      await expect(
        Test.createTestingModule({ providers: [CheckoutService, ...others] }).compile(),
      ).rejects.toThrow(/ZERO_COLLECTIBLE_CONFIRMATION_HOOK|hook/i);
    });

    it('control: the same composition WITH the hook constructs', async () => {
      const { Test } = await import('@nestjs/testing');
      const { CheckoutService } = await import('../src/checkout/checkout.service');
      const { OrderService } = await import('@beauclick/commerce');
      const { BookingService } = await import('@beauclick/booking');
      const { PaymentService } = await import('@beauclick/payment');
      const { OutboxRelay } = await import('@beauclick/events');
      const { DataSource } = await import('typeorm');

      const moduleRef = await Test.createTestingModule({
        providers: [
          CheckoutService,
          { provide: DataSource, useValue: {} },
          { provide: BookingService, useValue: {} },
          { provide: OrderService, useValue: {} },
          { provide: PaymentService, useValue: {} },
          { provide: OutboxRelay, useValue: {} },
          { provide: ZERO_COLLECTIBLE_CONFIRMATION_HOOK, useValue: { async onZeroCollectibleConfirmation() {} } },
        ],
      }).compile();

      // One provider added, and now it compiles. That is what makes the
      // failure above attributable to the hook and to nothing else.
      expect(moduleRef.get(CheckoutService)).toBeDefined();
      await moduleRef.close();
    });
  });
});
