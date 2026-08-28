import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { BookingService } from '@beauclick/booking';
import { OrderService } from '@beauclick/commerce';
import { PaymentService, SandboxPaymentProvider } from '@beauclick/payment';

import { CheckoutService } from '../src/checkout/checkout.service';
import {
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * The SANDBOX payment lifecycle, end to end, against real PostgreSQL.
 *
 * Scope note, so this file's boundary with `payment-security.pg-spec.ts` is
 * explicit rather than accidental: that suite already proves the ADVERSARIAL
 * properties (forged callback, amount tampering in both directions,
 * duplicate/concurrent callbacks, replayed refunds, the production gate).
 * Those are NOT duplicated here. What this file covers is the lifecycle the
 * sandbox provider itself now supports and the older mock did not -- the
 * three-way SUCCESS / FAILURE / CANCEL decision, the cancel path as a state
 * distinct from decline, the gateway's own books being a real independent
 * record, and the full happy path's financial consequence.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Sandbox payment lifecycle on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let financialDataSource: DataSource;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;
  let orders: OrderService;
  let bookings: BookingService;
  let payments: PaymentService;
  let relay: { drain: () => Promise<{ dispatched: number; failed: number }> };

  /**
   * Drains until the outbox goes quiet, rather than a fixed number of times.
   *
   * One `drain()` is NOT enough for any multi-hop chain, and the refund chain
   * is two hops: `payments.refund()` writes `RefundCompleted` to the PAYMENT
   * outbox; dispatching it makes `RefundCompletedCommerceHandler` write
   * `OrderRefunded` to the COMMERCE outbox; only dispatching THAT reaches the
   * ledger. A single pass scans `commerce` before `payment` (that is the
   * registered source order) and fetches each source's pending rows once up
   * front, so the row hop 1 creates is invisible to the pass that created it.
   * Looping until nothing is dispatched makes these assertions independent of
   * both the source ordering and the chain's length.
   */
  async function drainUntilQuiet(maxPasses = 5): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      const { dispatched } = await relay.drain();
      if (dispatched === 0) return;
    }
  }

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    financialDataSource = ctx.financialDataSource;
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
    orders = app.get(OrderService);
    bookings = app.get(BookingService);
    payments = app.get(PaymentService);
    relay = ctx.relay;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  let seq = 0;
  async function reachGateway(priceToman = 200_000) {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+98940${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98941${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا سندباکس', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(100 + seq));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      // A callback BASE, not a full URL: `initiate` appends the intent's own
      // provider key. This mirrors the real controller, which is where R31-17
      // lived -- it used to hand a full URL hardcoding `/callback/mock`.
      callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
    });

    const [attempt] = await dataSource.query(
      `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
      [result.paymentIntentId],
    );

    return { owner, customer, professional, result, reference: attempt?.provider_reference as string };
  }

  describe('initiation records real gateway-side books', () => {
    it('creates a pending sandbox transaction carrying the order it was asked to charge for', async () => {
      const { result, reference } = await reachGateway(340_000);

      expect(reference).toMatch(/^SBX-/);
      const tx = await sandbox.inspect(reference);
      expect(tx).not.toBeNull();
      expect(tx?.outcome).toBe('pending');
      // The §4 data model: the simulated bank records WHAT it was asked to
      // charge and for which order, so QA can reconcile independently.
      expect(tx?.orderId).toBe(result.order.order.id);
      expect(tx?.paymentIntentId).toBe(result.paymentIntentId);
      expect(tx?.amountToman).toBe(340_000);
      expect(tx?.currency).toBe('IRT');
      // No settlement reference exists until money actually moves.
      expect(tx?.settlementReference).toBeNull();
    });

    it('hands back a redirect URL pointing at the sandbox checkout, carrying the reference and callback', async () => {
      const { result, reference } = await reachGateway();
      expect(result.redirectUrl).toContain('/sandbox-gateway');
      expect(result.redirectUrl).toContain(encodeURIComponent(reference));
    });

    /**
     * R31-17 regression. The embedded callback the gateway will return the
     * browser to MUST address the intent's own provider (`sandbox`), because
     * the callback resolves the attempt by `(providerKey, reference)`. The bug
     * was a hardcoded `/callback/mock` in the checkout controller, which the
     * automated suite never caught because every other test called
     * `handleCallback('sandbox', ...)` directly and skipped the URL
     * construction. This asserts the URL construction itself.
     */
    it('embeds a callback that addresses the payment provider, never a hardcoded one', async () => {
      const { result } = await reachGateway();
      // The redirect carries `callback=<encoded callback URL>`.
      const decoded = decodeURIComponent(result.redirectUrl ?? '');
      expect(decoded).toContain('/v1/payments/callback/sandbox');
      // The exact bug: it must NOT point at a `mock` provider the attempt is
      // not keyed under.
      expect(decoded).not.toContain('/v1/payments/callback/mock');
    });

    /**
     * §4: the old mock callback path cannot accidentally verify a sandbox
     * payment. Even with the decision recorded as paid, `handleCallback('mock',
     * ...)` cannot resolve the `sandbox`-keyed attempt -- it is refused with the
     * same generic not-found a forged reference gets, and the order stays
     * unpaid. This is the failure that left every browser payment pending.
     */
    it('refuses to verify a sandbox payment through the WRONG provider callback', async () => {
      const { result, reference } = await reachGateway(220_000);
      expect(await sandbox.decide(reference, 'success')).toBe(true);

      await expect(checkout.handleCallback('mock', reference, { reference })).rejects.toBeDefined();

      // The order is untouched: no cross-provider callback can mark it paid.
      const order = await orders.findById(result.order.order.id);
      expect(order?.status).not.toBe('paid');
    });
  });

  describe('SUCCESS path', () => {
    it('runs initiate -> decide -> callback -> verify -> paid -> confirmed, and lands a real ledger entry', async () => {
      const { result, reference } = await reachGateway(500_000);

      expect(await sandbox.decide(reference, 'success')).toBe(true);

      const callback = await checkout.handleCallback('sandbox', reference, { reference });
      expect(callback.outcome.status).toBe('succeeded');

      const order = await orders.findById(result.order.order.id);
      expect(order?.status).toBe('paid');
      expect(order?.paidAt).not.toBeNull();

      const booking = await bookings.findById(result.bookingId);
      expect(booking?.status).toBe('confirmed');

      // The financial consequence, through the REAL financial service on its
      // own append-only connection -- not a fake path.
      await drainUntilQuiet();
      const entries = await financialDataSource.query(
        `SELECT entry_type, amount_toman FROM financial.ledger_entries WHERE order_id = $1 ORDER BY entry_type`,
        [result.order.order.id],
      );
      expect(entries).toHaveLength(2);
      const commission = entries.find((e: { entry_type: string }) => e.entry_type === 'commission');
      const receivable = entries.find((e: { entry_type: string }) => e.entry_type === 'receivable');
      // 15% commission of 500,000, and the two must sum EXACTLY to what was paid.
      expect(Number(commission.amount_toman) + Number(receivable.amount_toman)).toBe(500_000);
      expect(Number(commission.amount_toman)).toBe(75_000);
    });

    it('assigns a settlement reference only on the paid path', async () => {
      const { reference } = await reachGateway();
      await sandbox.decide(reference, 'success');
      const tx = await sandbox.inspect(reference);
      expect(tx?.outcome).toBe('paid');
      expect(tx?.settlementReference).toMatch(/^SBXTX-/);
    });
  });

  describe('FAILURE path (the bank refused)', () => {
    it('verifies as failed with a `declined` code, leaves the order unpaid and writes no ledger entry', async () => {
      const { result, reference } = await reachGateway();

      expect(await sandbox.decide(reference, 'failure')).toBe(true);

      const callback = await checkout.handleCallback('sandbox', reference, { reference });
      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('declined');

      const order = await orders.findById(result.order.order.id);
      expect(order?.status).toBe('pending');
      expect(order?.paidAt).toBeNull();

      // A declined transaction must never carry proof money moved.
      const tx = await sandbox.inspect(reference);
      expect(tx?.outcome).toBe('declined');
      expect(tx?.settlementReference).toBeNull();

      await drainUntilQuiet();
      const entries = await financialDataSource.query(
        `SELECT count(*)::int AS n FROM financial.ledger_entries WHERE order_id = $1`,
        [result.order.order.id],
      );
      expect(entries[0].n).toBe(0);
    });
  });

  describe('CANCEL path (the customer walked away)', () => {
    it('is a state DISTINCT from decline, with its own failure code', async () => {
      const { result, reference } = await reachGateway();

      expect(await sandbox.decide(reference, 'cancel')).toBe(true);

      const tx = await sandbox.inspect(reference);
      // The whole point of this phase's outcome split: cancelled is not declined.
      expect(tx?.outcome).toBe('cancelled');
      expect(tx?.settlementReference).toBeNull();

      const callback = await checkout.handleCallback('sandbox', reference, { reference });
      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('cancelled_by_user');

      const order = await orders.findById(result.order.order.id);
      expect(order?.status).toBe('pending');

      await drainUntilQuiet();
      const entries = await financialDataSource.query(
        `SELECT count(*)::int AS n FROM financial.ledger_entries WHERE order_id = $1`,
        [result.order.order.id],
      );
      expect(entries[0].n).toBe(0);
    });
  });

  describe('the gateway decision is itself compare-and-swapped', () => {
    it('refuses a SECOND decision on an already-decided transaction', async () => {
      const { reference } = await reachGateway();

      expect(await sandbox.decide(reference, 'success')).toBe(true);
      // A customer double-submitting the sandbox page, or a second tab,
      // cannot flip a decided transaction.
      expect(await sandbox.decide(reference, 'failure')).toBe(false);
      expect(await sandbox.decide(reference, 'cancel')).toBe(false);

      expect((await sandbox.inspect(reference))?.outcome).toBe('paid');
    });

    it('resolves genuinely CONCURRENT conflicting decisions to exactly one winner', async () => {
      const { reference } = await reachGateway();

      const results = await Promise.all([
        sandbox.decide(reference, 'success'),
        sandbox.decide(reference, 'failure'),
        sandbox.decide(reference, 'cancel'),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const tx = await sandbox.inspect(reference);
      expect(['paid', 'declined', 'cancelled']).toContain(tx?.outcome);
    });
  });

  describe('refund', () => {
    it('refunds a paid transaction and reverses it in the real ledger', async () => {
      const { result, reference } = await reachGateway(400_000);
      await sandbox.decide(reference, 'success');
      await checkout.handleCallback('sandbox', reference, { reference });
      await drainUntilQuiet();

      await payments.refund({
        orderId: result.order.order.id,
        amountToman: 400_000,
        reason: 'تست بازگشت وجه',
        requestKey: `sandbox-refund:${result.order.order.id}`,
        actorType: 'system',
        actorId: null,
      });
      await drainUntilQuiet();

      const tx = await sandbox.inspect(reference);
      expect(tx?.refundReference).toMatch(/^SBXRF-/);

      // The ledger reverses; it never rewrites. Net receivable returns to zero.
      const [{ net }] = await financialDataSource.query(
        `SELECT COALESCE(SUM(amount_toman), 0)::bigint AS net FROM financial.ledger_entries
          WHERE order_id = $1 AND entry_type = 'receivable'`,
        [result.order.order.id],
      );
      expect(Number(net)).toBe(0);
    });

    it('is idempotent on the gateway side -- a replayed refund returns the FIRST reference, never a second', async () => {
      const { reference } = await reachGateway();
      await sandbox.decide(reference, 'success');

      const first = await sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never);
      const second = await sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never);

      expect(first.outcome).toBe('succeeded');
      expect(second.outcome).toBe('succeeded');
      expect(second.providerRefundReference).toBe(first.providerRefundReference);
    });

    it('holds under genuinely CONCURRENT refunds -- one reference, never two', async () => {
      const { reference } = await reachGateway();
      await sandbox.decide(reference, 'success');

      const results = await Promise.all([
        sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never),
        sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never),
        sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never),
      ]);

      const references = new Set(results.map((r) => r.providerRefundReference));
      expect(references.size).toBe(1);
      expect([...references][0]).toBe((await sandbox.inspect(reference))?.refundReference);
    });

    it('refuses to refund a transaction that never paid', async () => {
      const { reference } = await reachGateway();
      await sandbox.decide(reference, 'failure');

      const refund = await sandbox.refund({ providerReference: reference, amountToman: 1, reason: 'r' } as never);
      expect(refund.outcome).toBe('failed');
      expect(refund.failureCode).toBe('not_refundable');
    });

    it('refuses to refund an unknown transaction', async () => {
      const refund = await sandbox.refund({ providerReference: 'SBX-NOPE', amountToman: 1, reason: 'r' } as never);
      expect(refund.outcome).toBe('failed');
      expect(refund.failureCode).toBe('not_refundable');
    });
  });

  describe('the sandbox checkout endpoint', () => {
    it('accepts each of the three real decisions', async () => {
      for (const decision of ['success', 'failure', 'cancel'] as const) {
        const { reference } = await reachGateway();
        const response = await request(app.getHttpServer())
          .post(`/api/v1/sandbox-gateway/${reference}/decide`)
          .send({ decision })
          .expect(201);
        expect(response.body.data.accepted).toBe(true);
      }
    });

    it('REFUSES an unrecognised decision rather than defaulting to paid', async () => {
      const { reference } = await reachGateway();

      // The old endpoint took `{ paid?: boolean }` and treated anything but
      // an explicit `false` as payment -- so a typo'd field name silently
      // meant "paid". That leniency is gone.
      for (const body of [{}, { decision: '' }, { decision: 'SUCCESS' }, { decision: 'paid' }, { paid: true }]) {
        const response = await request(app.getHttpServer())
          .post(`/api/v1/sandbox-gateway/${reference}/decide`)
          .send(body)
          .expect(201);
        expect(response.body.data.accepted).toBe(false);
        expect(response.body.data.reason).toBe('unknown_decision');
      }

      // Nothing was decided by any of those attempts.
      expect((await sandbox.inspect(reference))?.outcome).toBe('pending');
    });

    it('does not require authentication -- a real gateway page carries no BeauClick session', async () => {
      const { reference } = await reachGateway();
      await request(app.getHttpServer())
        .post(`/api/v1/sandbox-gateway/${reference}/decide`)
        .send({ decision: 'success' })
        .expect(201);
    });
  });
});
