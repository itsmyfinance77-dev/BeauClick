import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OrderService } from '@beauclick/commerce';
import { SandboxPaymentProvider } from '@beauclick/payment';

import { CheckoutService } from '../src/checkout/checkout.service';
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
  '20260905900003_add_collected_total_and_capture_state.sql',
);

/**
 * Deposit capture and collected-money accounting — V3.3 #82 (`#41c`),
 * ADR-045, `V33-DEC-024`.
 *
 * ## Why this suite is here
 *
 * Every claim #82 makes is about money meeting PostgreSQL: that a refund cannot
 * exceed the captured principal even when it is below the service total, that
 * the capture statement's compare-and-swap admits exactly one winner, that
 * `ck_orders_refund_within_collected` refuses a raw over-refund, and that the
 * ledger never receives a venue balance. pg-mem enforces no CHECK, honours no
 * ROLLBACK and runs no PL/pgSQL, so none of it is observable on the fast layer.
 *
 * ## The deposit fixture, and why it is not a selector
 *
 * No public request can choose a collection mode, and #82 adds none — that is
 * #83's work. So a deposit schedule is planted directly, and the database's own
 * `ck_ops_mode_consistent` refuses a fixture that is not a real deposit
 * (`0 < collectible < service_total`, strictly). Everything after the plant is
 * the production pipeline: real intent, real sandbox provider, real
 * verification, real callback, real order and booking transitions, real events,
 * real ledger.
 *
 * ## Non-vacuity
 *
 * Every assertion of absence is paired with a positive control in this same
 * suite against the same tables — a full-online order that DOES emit
 * `OrderPaid`, a refund that DOES succeed at exactly the collected amount, a
 * ledger that DOES receive the collectible.
 */
describePg('deposit capture and collected-money accounting (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;

  let sequence = 0;
  const nextPhone = (): string => `+98915${String(1000000 + (sequence += 1)).slice(-7)}`;

  const CALLBACK_BASE = 'http://localhost:3099/api/v1/payments/callback';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
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

  const orderRow = async (orderId: string) => {
    const [row] = await dataSource.query('SELECT * FROM commerce.orders WHERE id = $1', [orderId]);
    return row;
  };

  const bookingRow = async (bookingId: string) => {
    const [row] = await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]);
    return row;
  };

  const commerceEvents = async (orderId: string): Promise<string[]> => {
    const rows = await dataSource.query(
      'SELECT event_type FROM commerce.outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [orderId],
    );
    return rows.map((r: { event_type: string }) => r.event_type);
  };

  const eventPayload = async (orderId: string, type: string): Promise<Record<string, unknown> | null> => {
    const [row] = await dataSource.query(
      'SELECT payload FROM commerce.outbox_events WHERE aggregate_id = $1 AND event_type = $2 ORDER BY id LIMIT 1',
      [orderId, type],
    );
    return row ? row.payload : null;
  };

  const countRows = async (sql: string, params: unknown[] = []): Promise<number> => {
    const [row] = await dataSource.query(sql, params);
    return Number(row?.count ?? 0);
  };

  interface Booked {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
    reference: string | null;
    intentId: string | null;
  }

  /** A booking through the real public checkout route, then its gateway reference. */
  async function book(priceToman: number): Promise<Booked> {
    sequence += 1;
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص سپرده', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48 + sequence));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: CALLBACK_BASE,
    });

    let reference: string | null = null;
    if (result.paymentIntentId) {
      const [row] = await dataSource.query(
        'SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1',
        [result.paymentIntentId],
      );
      reference = row?.provider_reference ?? null;
    }

    return {
      customer,
      bookingId: result.bookingId,
      orderId: result.order.order.id,
      reference,
      intentId: result.paymentIntentId,
    };
  }

  /**
   * Replace an order's schedule with a real `deposit_online_balance_at_venue`
   * row, and re-price the intent to the collectible.
   *
   * The schedule is immutable, so the existing row is removed with the trigger
   * disabled — a test-fixture concession explicitly unavailable to production
   * code. `ck_ops_mode_consistent` then refuses anything that is not a genuine
   * deposit, so this fixture cannot accidentally plant a full-online or
   * pay-at-venue row wearing a deposit label.
   */
  async function makeDeposit(orderId: string, serviceTotal: number, collectible: number): Promise<void> {
    await dataSource.query(
      'ALTER TABLE commerce.order_payment_schedules DISABLE TRIGGER tg_order_payment_schedules_immutable',
    );
    try {
      await dataSource.query('DELETE FROM commerce.order_payment_schedules WHERE order_id = $1', [orderId]);
    } finally {
      await dataSource.query(
        'ALTER TABLE commerce.order_payment_schedules ENABLE TRIGGER tg_order_payment_schedules_immutable',
      );
    }
    await dataSource.query(
      `INSERT INTO commerce.order_payment_schedules
         (order_id, collection_mode, service_total_toman, platform_collectible_toman, venue_balance_toman, contract_version)
       VALUES ($1, 'deposit_online_balance_at_venue', $2, $3, $4, 1)`,
      [orderId, serviceTotal, collectible, serviceTotal - collectible],
    );
    // The intent was created for the full-online collectible; re-price it so the
    // gateway is asked for the deposit, exactly as production would.
    await dataSource.query(
      'UPDATE payment.payment_intents SET amount_toman = $2 WHERE order_id = $1',
      [orderId, collectible],
    );
    await dataSource.query(
      `UPDATE payment.payment_attempts a SET requested_amount_toman = $2
         FROM payment.payment_intents i WHERE i.id = a.payment_intent_id AND i.order_id = $1`,
      [orderId, collectible],
    );
    /*
     * The sandbox gateway's OWN record of what it will report as paid.
     *
     * Re-priced too, and the first version of this fixture did not do it --
     * which made every deposit verification fail with an amount mismatch.
     * That failure was the production guard working exactly as designed
     * (`providerResult.paidAmountToman === intent.amountToman`), catching a
     * fixture that had moved the intent without moving the gateway. Left
     * recorded here because the guard proving itself against a mistake is
     * better evidence than the assertion that it exists.
     */
    await dataSource.query(
      'UPDATE payment.sandbox_transactions SET amount_toman = $2 WHERE order_id = $1',
      [orderId, collectible],
    );
  }

  /** Drive a booked order through a successful sandbox capture. */
  async function capture(booked: Booked) {
    await sandbox.decide(booked.reference as string, 'success');
    return checkout.handleCallback('sandbox', booked.reference as string, {
      reference: booked.reference as string,
    });
  }

  const SERVICE_TOTAL = 300_000;
  const COLLECTIBLE = 90_000;
  const VENUE_BALANCE = SERVICE_TOTAL - COLLECTIBLE;

  async function depositCapture(): Promise<Booked> {
    const booked = await book(SERVICE_TOTAL);
    await makeDeposit(booked.orderId, SERVICE_TOTAL, COLLECTIBLE);
    const result = await capture(booked);
    expect(result.outcome.status).toBe('succeeded');
    return booked;
  }

  // =========================================================================
  // 1. Public creation stays full-online; the fixture is not a selector
  // =========================================================================

  describe('no collection mode is reachable through any route', () => {
    it('public order creation still produces exactly full_payment_online', async () => {
      await book(SERVICE_TOTAL);
      const rows = await dataSource.query('SELECT DISTINCT collection_mode FROM commerce.order_payment_schedules');
      expect(rows).toEqual([{ collection_mode: 'full_payment_online' }]);
    });

    it('the database refuses a planted schedule that is not a real deposit', async () => {
      const booked = await book(SERVICE_TOTAL);
      await dataSource.query(
        'ALTER TABLE commerce.order_payment_schedules DISABLE TRIGGER tg_order_payment_schedules_immutable',
      );
      try {
        await dataSource.query('DELETE FROM commerce.order_payment_schedules WHERE order_id = $1', [booked.orderId]);
      } finally {
        await dataSource.query(
          'ALTER TABLE commerce.order_payment_schedules ENABLE TRIGGER tg_order_payment_schedules_immutable',
        );
      }
      // collectible == service total is full-online, not a deposit.
      await expect(
        dataSource.query(
          `INSERT INTO commerce.order_payment_schedules
             (order_id, collection_mode, service_total_toman, platform_collectible_toman, venue_balance_toman, contract_version)
           VALUES ($1, 'deposit_online_balance_at_venue', $2, $2, 0, 1)`,
          [booked.orderId, SERVICE_TOTAL],
        ),
      ).rejects.toThrow(/ck_ops_mode_consistent/);
    });
  });

  // =========================================================================
  // 2. The deposit pipeline, end to end
  // =========================================================================

  describe('a deposit capture records exactly what was collected', () => {
    it('asks the gateway for the collectible, not the service total', async () => {
      const booked = await book(SERVICE_TOTAL);
      await makeDeposit(booked.orderId, SERVICE_TOTAL, COLLECTIBLE);

      const [intent] = await dataSource.query(
        'SELECT amount_toman FROM payment.payment_intents WHERE order_id = $1',
        [booked.orderId],
      );
      expect(Number(intent.amount_toman)).toBe(COLLECTIBLE);
      expect(Number(intent.amount_toman)).not.toBe(SERVICE_TOTAL);
    });

    it('captures the collectible, confirms the booking and reaches online_collection_completed', async () => {
      const booked = await depositCapture();

      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('online_collection_completed');
      expect(Number(row.collected_total_toman)).toBe(COLLECTIBLE);
      expect(Number(row.total_toman)).toBe(SERVICE_TOTAL);
      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
    });

    it('emits exactly one OrderCollectionCaptured and never OrderPaid', async () => {
      const booked = await depositCapture();

      const types = await commerceEvents(booked.orderId);
      expect(types.filter((t) => t === 'OrderCollectionCaptured')).toHaveLength(1);
      expect(types).not.toContain('OrderPaid');
      expect(types).toEqual(['OrderCreated', 'OrderCollectionCaptured']);
    });

    it('the capture payload names the three amounts separately and never totalToman', async () => {
      const booked = await depositCapture();
      const payload = (await eventPayload(booked.orderId, 'OrderCollectionCaptured')) as Record<string, number>;

      expect(payload.serviceTotalToman).toBe(SERVICE_TOTAL);
      expect(payload.platformCollectedToman).toBe(COLLECTIBLE);
      expect(payload.venueBalanceToman).toBe(VENUE_BALANCE);
      // The name that carried the ambiguity must not exist here at all.
      expect(Object.keys(payload)).not.toContain('totalToman');
    });

    it('the ledger records the collectible and no venue balance', async () => {
      const booked = await depositCapture();
      await ctx.relay.drain();

      const entries = await ctx.financialDataSource.query(
        `SELECT entry_type, amount_toman FROM financial.ledger_entries WHERE order_id = $1 ORDER BY entry_type`,
        [booked.orderId],
      );
      expect(entries.length).toBeGreaterThan(0);
      const sum = entries.reduce((acc: number, e: { amount_toman: string }) => acc + Number(e.amount_toman), 0);
      expect(sum).toBe(COLLECTIBLE);
      for (const e of entries) {
        expect(Number(e.amount_toman)).not.toBe(SERVICE_TOTAL);
        expect(Number(e.amount_toman)).not.toBe(VENUE_BALANCE);
      }
    });

    /** The positive control for every "never the service total" assertion above. */
    it('control: a full-online capture still emits the exact unchanged OrderPaid v1', async () => {
      const booked = await book(SERVICE_TOTAL);
      const result = await capture(booked);
      expect(result.outcome.status).toBe('succeeded');

      const types = await commerceEvents(booked.orderId);
      expect(types).toEqual(['OrderCreated', 'OrderPaid']);
      expect(types).not.toContain('OrderCollectionCaptured');

      const payload = (await eventPayload(booked.orderId, 'OrderPaid')) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'currency',
        'customerId',
        'orderId',
        'paidAt',
        'sellerPartyId',
        'sellerPartyType',
        'sourceId',
        'sourceType',
        'totalToman',
      ]);
      expect(payload.totalToman).toBe(SERVICE_TOTAL);

      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('paid');
      expect(Number(row.collected_total_toman)).toBe(SERVICE_TOTAL);
    });

    it('control: the #81 zero-collectible path emits neither capture event', async () => {
      const booked = await book(0);
      expect(booked.intentId).toBeNull();

      const types = await commerceEvents(booked.orderId);
      expect(types).toEqual(['OrderCreated']);
      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('online_collection_not_required');
      expect(Number(row.collected_total_toman)).toBe(0);
    });
  });

  // =========================================================================
  // 3. Capture refusal, replay, duplicate charge
  // =========================================================================

  describe('capture integrity', () => {
    it('a verified amount that is not the collectible captures nothing, atomically', async () => {
      const booked = await book(SERVICE_TOTAL);
      await makeDeposit(booked.orderId, SERVICE_TOTAL, COLLECTIBLE);

      await expect(
        dataSource.transaction((m) => orders.recordVerifiedCapture(booked.orderId, COLLECTIBLE + 1, m)),
      ).resolves.toEqual({ outcome: 'refused', reason: 'amount_not_collectible' });

      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('pending');
      expect(Number(row.collected_total_toman)).toBe(0);
      expect(await commerceEvents(booked.orderId)).toEqual(['OrderCreated']);
    });

    it('N concurrent captures produce exactly one winner and one event', async () => {
      const booked = await book(SERVICE_TOTAL);
      await makeDeposit(booked.orderId, SERVICE_TOTAL, COLLECTIBLE);

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () =>
          dataSource.transaction((m) => orders.recordVerifiedCapture(booked.orderId, COLLECTIBLE, m)),
        ),
      );

      expect(outcomes.filter((o) => o.outcome === 'captured')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'already')).toHaveLength(4);
      const types = await commerceEvents(booked.orderId);
      expect(types.filter((t) => t === 'OrderCollectionCaptured')).toHaveLength(1);
      expect(Number((await orderRow(booked.orderId)).collected_total_toman)).toBe(COLLECTIBLE);
    });

    it('a replayed callback creates no second capture, event or booking transition', async () => {
      const booked = await depositCapture();
      const before = await commerceEvents(booked.orderId);

      const replay = await checkout.handleCallback('sandbox', booked.reference as string, {
        reference: booked.reference as string,
      });
      expect(replay.outcome.status).toBe('replayed');

      expect(await commerceEvents(booked.orderId)).toEqual(before);
      expect(Number((await orderRow(booked.orderId)).collected_total_toman)).toBe(COLLECTIBLE);
    });
  });

  // =========================================================================
  // 4. Refunds are bounded by collected money
  // =========================================================================

  describe('refunds cannot exceed the captured principal', () => {
    it('refuses collected + 1 even though it is far below the service total', async () => {
      const booked = await depositCapture();

      await expect(
        orders.recordRefund(booked.orderId, COLLECTIBLE + 1, '01a07000-0000-7000-8000-00000000c001'),
      ).rejects.toThrow(/REFUND_EXCEEDS_ORDER|بازگشتی/);

      // The amount refused is unambiguously below the service total: this is the
      // exact case the old total-based ceiling permitted.
      expect(COLLECTIBLE + 1).toBeLessThan(SERVICE_TOTAL);
      expect(Number((await orderRow(booked.orderId)).refunded_total_toman)).toBe(0);
    });

    it('control: a refund of exactly the collected amount succeeds and reaches refunded', async () => {
      const booked = await depositCapture();

      const ok = await orders.recordRefund(booked.orderId, COLLECTIBLE, '01a07000-0000-7000-8000-00000000c002');
      expect(ok).toBe(true);

      const row = await orderRow(booked.orderId);
      expect(row.status).toBe('refunded');
      expect(Number(row.refunded_total_toman)).toBe(COLLECTIBLE);
      // The principal is never reduced by a refund.
      expect(Number(row.collected_total_toman)).toBe(COLLECTIBLE);
    });

    it('concurrent refunds cannot exceed the collected principal', async () => {
      const booked = await depositCapture();

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          orders.recordRefund(booked.orderId, COLLECTIBLE, `01a07000-0000-7000-8000-00000000d00${i}`),
        ),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value === true);
      expect(succeeded).toHaveLength(1);
      expect(Number((await orderRow(booked.orderId)).refunded_total_toman)).toBe(COLLECTIBLE);
    });

    it('raw SQL cannot over-refund either — the CHECK is the guarantee', async () => {
      const booked = await depositCapture();

      await expect(
        dataSource.query('UPDATE commerce.orders SET refunded_total_toman = $2 WHERE id = $1', [
          booked.orderId,
          COLLECTIBLE + 1,
        ]),
      ).rejects.toThrow(/ck_orders_refund_within_collected/);
    });

    it('remainingRefundable reports collected money, never the service total', async () => {
      const booked = await depositCapture();
      const order = await orders.findById(booked.orderId);
      expect(orders.remainingRefundable(order!)).toBe(COLLECTIBLE);
      expect(orders.remainingRefundable(order!)).not.toBe(SERVICE_TOTAL);
    });
  });

  // =========================================================================
  // 5. Cancellation
  // =========================================================================

  describe('cancelling a captured deposit', () => {
    it('refunds the entire remaining collected amount, once', async () => {
      const booked = await depositCapture();
      await ctx.relay.drain();

      const handler = app.get(BookingCancelledRefundHandler);
      await handler.handle({ payload: { bookingId: booked.bookingId } } as never);
      await handler.handle({ payload: { bookingId: booked.bookingId } } as never);

      const refunds = await dataSource.query(
        'SELECT amount_toman FROM payment.refunds WHERE order_id = $1',
        [booked.orderId],
      );
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0].amount_toman)).toBe(COLLECTIBLE);
      expect(Number(refunds[0].amount_toman)).not.toBe(SERVICE_TOTAL);
    });

    it('control: a never-collected order calls no provider refund', async () => {
      const booked = await book(0);
      const handler = app.get(BookingCancelledRefundHandler);
      await handler.handle({ payload: { bookingId: booked.bookingId } } as never);

      expect(await countRows('SELECT count(*) FROM payment.refunds')).toBe(0);
      expect((await orderRow(booked.orderId)).status).toBe('cancelled');
    });
  });

  // =========================================================================
  // 6. Retry, and the migration itself
  // =========================================================================

  describe('retry and schema', () => {
    it('a successfully captured deposit is not retryable', async () => {
      const booked = await depositCapture();

      /*
       * Asserted on the closed public reason, not merely that it threw.
       *
       * A captured deposit is refused TWICE over: the order is no longer
       * `pending`, and its intent has already succeeded. A probe that removes
       * only the first guard therefore still yields a refusal -- correctly, and
       * that is worth knowing -- so this pins WHICH refusal, which is the one
       * the order-state guard produces.
       */
      await expect(
        checkout.retryPayment({
          orderId: booked.orderId,
          customerId: booked.customer.id,
          callbackBaseUrl: CALLBACK_BASE,
        }),
      ).rejects.toMatchObject({ details: { reason: 'order_not_payable' } });
    });

    it('the status allowlist names all seven statuses and refuses an unknown one', async () => {
      const [row] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_orders_status'`,
      );
      for (const s of [
        'pending', 'paid', 'partially_refunded', 'refunded', 'cancelled',
        'online_collection_not_required', 'online_collection_completed',
      ]) {
        expect(row.def).toContain(s);
      }

      const booked = await book(SERVICE_TOTAL);
      await expect(
        dataSource.query('UPDATE commerce.orders SET status = $2 WHERE id = $1', [booked.orderId, 'not_a_status']),
      ).rejects.toThrow(/ck_orders_status/);
    });

    it('the old total-based refund constraint is gone and the collected-based one exists', async () => {
      const names = await dataSource.query(
        `SELECT conname FROM pg_constraint WHERE conname LIKE 'ck_orders_%' ORDER BY conname`,
      );
      const set = names.map((r: { conname: string }) => r.conname);
      expect(set).toContain('ck_orders_refund_within_collected');
      expect(set).toContain('ck_orders_collected_within_total');
      expect(set).not.toContain('ck_orders_refund_within_total');
    });

    it('a principal above the order total is refused', async () => {
      const booked = await book(SERVICE_TOTAL);
      await expect(
        dataSource.query('UPDATE commerce.orders SET collected_total_toman = $2 WHERE id = $1', [
          booked.orderId,
          SERVICE_TOTAL + 1,
        ]),
      ).rejects.toThrow(/ck_orders_collected_within_total/);
    });

    it('the migration file itself drops the old ceiling and backfills by lifecycle', () => {
      // Read from disk rather than retyped: an inlined copy would pass while the
      // real migration did something else.
      const sql = readFileSync(MIGRATION_PATH, 'utf8');
      expect(sql).toContain('DROP CONSTRAINT ck_orders_refund_within_total');
      expect(sql).toContain('ck_orders_refund_within_collected');
      // The CHECK's own text, not merely its name: a migration that kept the
      // name but bounded on total_toman would otherwise pass. A mutation probe
      // found exactly that gap.
      expect(sql).toContain('CHECK (refunded_total_toman <= collected_total_toman)');
      expect(sql).toContain("SET collected_total_toman = total_toman");
      expect(sql).not.toContain('DROP TABLE');
    });
  });

  // =========================================================================
  // 7. Downstream consumers
  // =========================================================================

  describe('consumers', () => {
    it('the deposit notification shows the collected amount and not the service total', async () => {
      const booked = await depositCapture();
      await ctx.relay.drain();

      const rows = await dataSource.query(
        `SELECT payload FROM notification.notifications WHERE user_id = $1 AND template_key = 'payment_succeeded'`,
        [booked.customer.id],
      );
      expect(rows).toHaveLength(1);
      /*
       * The template variable is rendered with Persian digits and a Persian
       * thousands separator, so the raw JSON reads ۹۰٬۰۰۰. Normalising back to
       * Latin digits keeps the assertion about the AMOUNT rather than about
       * the numeral system, and keeps it readable.
       */
      const toLatin = (s: string): string =>
        s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/٬/g, '');
      const rendered = toLatin(JSON.stringify(rows[0].payload));

      expect(rendered).toContain(String(COLLECTIBLE));
      expect(rendered).not.toContain(String(SERVICE_TOTAL));
    });

    it('loyalty, journey and referral gain nothing from a deposit capture', async () => {
      const booked = await depositCapture();
      await ctx.relay.drain();

      expect(await countRows('SELECT count(*) FROM loyalty.points_entries')).toBe(0);
      expect(
        await countRows('SELECT count(*) FROM referral.referrals WHERE qualifying_booking_id = $1', [booked.bookingId]),
      ).toBe(0);
    });

    it('analytics records the collected amount as the capture fact', async () => {
      const booked = await depositCapture();
      await ctx.relay.drain();

      const rows = await dataSource.query(
        `SELECT metric_value FROM analytics.events WHERE event_type = 'OrderCollectionCaptured' AND subject_id = $1`,
        [booked.orderId],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].metric_value)).toBe(COLLECTIBLE);
    });

    it('the browser receipt exposes all three schedule amounts plus collected, as server facts', async () => {
      const booked = await depositCapture();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${booked.orderId}`)
        .set('Authorization', `Bearer ${booked.customer.accessToken}`)
        .expect(200);

      const body = res.body.data;
      expect(body.status).toBe('online_collection_completed');
      expect(body.collectedTotalToman).toBe(COLLECTIBLE);
      expect(body.totalToman).toBe(SERVICE_TOTAL);
      expect(body.paymentSchedule.serviceTotalToman).toBe(SERVICE_TOTAL);
      expect(body.paymentSchedule.platformCollectibleNowToman).toBe(COLLECTIBLE);
      expect(body.paymentSchedule.venueBalanceToman).toBe(VENUE_BALANCE);
    });
  });
});
