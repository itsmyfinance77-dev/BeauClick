import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { BookingService } from '@beauclick/booking';
import { OrderService } from '@beauclick/commerce';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { CheckoutService } from '../src/checkout/checkout.service';

import {
  PgTestApp,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * The verification contract a REAL gateway adapter will meet (V3.1 Phase F).
 *
 * `payment-security.pg-spec.ts` already proves that nothing but a genuine,
 * gateway-confirmed payment can mark an order paid. This suite asks the
 * question that sits next to it and had no answer: **what happens when the
 * gateway does not answer at all?**
 *
 * Before Phase F there were two words available -- `succeeded` and `failed` --
 * and a timing-out gateway had to be described with one of them. Both are
 * wrong, and `failed` is wrong in the expensive direction: it writes a
 * terminal status, emits `PaymentFailed` to five consumers, and tells a
 * customer whose card may well have been charged that no money moved. This
 * suite pins the third state.
 *
 * The sandbox provider is the harness, with its `verify()` replaced per case.
 * That is deliberate and is NOT a claim about any real gateway: it exercises
 * the CALLER's contract -- what `PaymentService` and `CheckoutService` do with
 * each kind of adapter answer -- which is the half of GAP-06b that can be
 * settled before a vendor exists. The vendor half stays open.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Gateway verification contract on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let orders: OrderService;
  let bookings: BookingService;
  let sandbox: SandboxPaymentProvider;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    orders = app.get(OrderService);
    bookings = app.get(BookingService);
    sandbox = app.get(SandboxPaymentProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  let seq = 0;
  async function bookAndReachGateway(priceToman = 200_000) {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+98922${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98923${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72 + seq));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
    });

    const attempts = await dataSource.query(
      `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
      [result.paymentIntentId],
    );

    return { customer, result, reference: attempts[0]?.provider_reference as string };
  }

  async function outboxCount(schema: string, eventType: string): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.outbox_events WHERE event_type = $1`,
      [eventType],
    );
    return count as number;
  }

  async function attemptRow(reference: string) {
    const [row] = await dataSource.query(
      `SELECT status, failure_code, verified_amount_toman, verified_at, provider_transaction_id
         FROM payment.payment_attempts WHERE provider_reference = $1`,
      [reference],
    );
    return row as {
      status: string;
      failure_code: string | null;
      verified_amount_toman: string | null;
      verified_at: Date | null;
      provider_transaction_id: string | null;
    };
  }

  /**
   * The central case. Everything else in this suite is a variation on it.
   */
  describe('an ambiguous verification writes nothing', () => {
    it.each([
      ['the adapter reports outcome: unknown', 'unknown-outcome'],
      ['the adapter throws a transport error', 'throws'],
      ['the adapter never answers and the deadline fires', 'hangs'],
    ])('%s -> unresolved, and no state changes', async (_label, mode) => {
      const { result, reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success'); // the bank DID take the money

      const spy = jest.spyOn(sandbox, 'verify').mockImplementation(async () => {
        if (mode === 'throws') throw new Error('ECONNRESET gateway.example:443');
        if (mode === 'hangs') return new Promise(() => undefined); // never settles
        return {
          outcome: 'unknown' as const,
          paidAmountToman: null,
          paidCurrency: null,
          providerTransactionId: null,
          failureCode: 'gateway_5xx',
        };
      });

      try {
        const callback = await checkout.handleCallback('sandbox', reference, { reference });

        expect(callback.outcome.status).toBe('unresolved');
        expect(callback.outcome.failureReason).toBe('unresolved');
        // Neither correction path may fire on an unresolved verification:
        // both move real money.
        expect(callback.refundIssued).toBe(false);
        expect(callback.duplicateChargeRefunded).toBe(false);

        // The ATTEMPT is untouched and still open. That is what makes the
        // state recoverable rather than merely non-destructive.
        const attempt = await attemptRow(reference);
        expect(attempt.status).toBe('initiated');
        expect(attempt.verified_at).toBeNull();
        expect(attempt.verified_amount_toman).toBeNull();
        expect(attempt.failure_code).toBeNull();

        const [intent] = await dataSource.query(
          `SELECT status, failure_code FROM payment.payment_intents WHERE id = $1`,
          [result.paymentIntentId],
        );
        expect(intent.status).toBe('pending');
        expect(intent.failure_code).toBeNull();

        expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
        expect((await bookings.findById(result.bookingId))?.status).toBe('pending');

        // No event at all. `PaymentFailed` would fan out to five consumers,
        // and the financial ledger is append-only -- an entry written on a
        // guess cannot be withdrawn.
        expect(await outboxCount('payment', 'PaymentFailed')).toBe(0);
        expect(await outboxCount('payment', 'PaymentSucceeded')).toBe(0);
        expect(await outboxCount('commerce', 'OrderPaid')).toBe(0);
      } finally {
        spy.mockRestore();
      }
    }, 45_000);

    it('leaves the payment RECOVERABLE -- a later honest callback still settles it', async () => {
      // The property that makes "write nothing" the right answer rather than
      // merely the cautious one. If an unresolved verification poisoned the
      // attempt, the customer's real payment could never be reconciled.
      const { result, reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success');

      const spy = jest.spyOn(sandbox, 'verify').mockRejectedValueOnce(new Error('ETIMEDOUT gateway.example:443'));

      const first = await checkout.handleCallback('sandbox', reference, { reference });
      expect(first.outcome.status).toBe('unresolved');
      spy.mockRestore();

      // The gateway comes back. Same reference, same attempt, no manual repair.
      const second = await checkout.handleCallback('sandbox', reference, { reference });
      expect(second.outcome.status).toBe('succeeded');

      expect((await orders.findById(result.order.order.id))?.status).toBe('paid');
      expect((await bookings.findById(result.bookingId))?.status).toBe('confirmed');
      expect(await outboxCount('payment', 'PaymentSucceeded')).toBe(1);
      expect(await outboxCount('commerce', 'OrderPaid')).toBe(1);
    });

    it('is not a replay -- the gateway IS asked again on the next callback', async () => {
      const { reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success');

      const spy = jest.spyOn(sandbox, 'verify').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await checkout.handleCallback('sandbox', reference, { reference });
      spy.mockRestore();

      const verifySpy = jest.spyOn(sandbox, 'verify');
      await checkout.handleCallback('sandbox', reference, { reference });
      expect(verifySpy).toHaveBeenCalledTimes(1);
      verifySpy.mockRestore();
    });
  });

  /**
   * The deadline exists because `prepareVerification` runs inside a request a
   * browser is waiting on, having just returned from a bank.
   */
  describe('the verification deadline', () => {
    it('bounds the wait rather than inheriting the gateway concept of one', async () => {
      const fast = await createPgTestApp({ PAYMENT_VERIFY_TIMEOUT_MS: '300' });
      try {
        const fastCheckout = fast.app.get(CheckoutService);
        const fastSandbox = fast.app.get(SandboxPaymentProvider);

        seq += 1;
        const owner = await seedUser(fast.app, fast.dataSource, `+98924${String(seq).padStart(7, '0')}`, ['professional']);
        const customer = await seedUser(fast.app, fast.dataSource, `+98925${String(seq).padStart(7, '0')}`);
        const professional = await seedProfessional(fast.dataSource, owner.id, 'سارا', 200_000);
        const slotId = await seedSlot(fast.dataSource, professional.id, professional.serviceId, futureSlotTime(500 + seq));
        const booked = await fastCheckout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId,
          serviceId: professional.serviceId,
          callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
        });
        const [{ provider_reference: ref }] = await fast.dataSource.query(
          `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
          [booked.paymentIntentId],
        );

        const spy = jest.spyOn(fastSandbox, 'verify').mockImplementation(() => new Promise(() => undefined));
        const startedAt = Date.now();
        const callback = await fastCheckout.handleCallback('sandbox', ref, { reference: ref });
        const elapsed = Date.now() - startedAt;
        spy.mockRestore();

        expect(callback.outcome.status).toBe('unresolved');
        expect(callback.outcome.failureCode).toBe('verification_timeout');
        // A generous upper bound: the assertion is "it returned because of the
        // deadline", not a latency benchmark.
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        await fast.app.close();
      }
    }, 60_000);
  });

  /**
   * `QA-21`. The redirect is the only channel the result page has, so what it
   * carries -- and what it must never carry -- is a contract, not a detail.
   */
  describe('the redirect contract carries a public failure reason', () => {
    async function callbackLocation(reference: string): Promise<URL> {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payments/callback/sandbox')
        .query({ reference })
        .expect(303);
      return new URL(response.headers.location as string);
    }

    it('distinguishes a customer cancelling from a bank declining', async () => {
      const cancelled = await bookAndReachGateway();
      await sandbox.decide(cancelled.reference, 'cancel');
      const cancelUrl = await callbackLocation(cancelled.reference);
      expect(cancelUrl.searchParams.get('status')).toBe('failed');
      expect(cancelUrl.searchParams.get('reason')).toBe('cancelled_by_user');

      const declined = await bookAndReachGateway();
      await sandbox.decide(declined.reference, 'failure');
      const declineUrl = await callbackLocation(declined.reference);
      expect(declineUrl.searchParams.get('status')).toBe('failed');
      // The whole of QA-21 in one assertion: these two were the same string.
      expect(declineUrl.searchParams.get('reason')).toBe('declined');
    });

    it('reports a customer who returned without completing anything', async () => {
      const { reference } = await bookAndReachGateway();
      const url = await callbackLocation(reference);
      expect(url.searchParams.get('status')).toBe('failed');
      expect(url.searchParams.get('reason')).toBe('not_completed');
    });

    it('attaches NO reason to a successful payment', async () => {
      const { result, reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success');
      const url = await callbackLocation(reference);
      expect(url.searchParams.get('status')).toBe('succeeded');
      expect(url.searchParams.get('reason')).toBeNull();
      expect(url.searchParams.get('orderId')).toBe(result.order.order.id);
    });

    it('reports an unresolved verification as unresolved, never as failed', async () => {
      const { reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success');
      const spy = jest.spyOn(sandbox, 'verify').mockRejectedValue(new Error('ETIMEDOUT'));
      try {
        const url = await callbackLocation(reference);
        expect(url.searchParams.get('status')).toBe('unresolved');
        expect(url.searchParams.get('reason')).toBe('unresolved');
      } finally {
        spy.mockRestore();
      }
    });

    it('NEVER publishes the gateway own failure code, however hostile', async () => {
      // The redaction boundary, asserted at the URL rather than at the pure
      // function: this is where a leak would actually reach a browser.
      const { reference } = await bookAndReachGateway();
      const hostile = 'NOK merchant 1234-5678 rejected authority A0000000000000000000000000123';
      const spy = jest.spyOn(sandbox, 'verify').mockResolvedValue({
        outcome: 'failed',
        paidAmountToman: null,
        paidCurrency: null,
        providerTransactionId: null,
        failureCode: hostile,
      });

      try {
        const url = await callbackLocation(reference);
        expect(url.searchParams.get('reason')).toBe('gateway_error');
        expect(url.toString()).not.toContain('merchant');
        expect(url.toString()).not.toContain('1234-5678');

        // The real code is still STORED, because that is what a support
        // engineer gives the gateway own support desk. Redacted in transit,
        // not discarded.
        const attempt = await attemptRow(reference);
        expect(attempt.failure_code).toBe(hostile.slice(0, 60));
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps the reason off the states where it would describe the wrong event', async () => {
      // A refunded outcome SUCCEEDED at the gateway and was corrected after.
      // Labelling it with a failure reason would misdescribe what happened.
      const { result, reference } = await bookAndReachGateway();
      await sandbox.decide(reference, 'success');
      await dataSource.query(`UPDATE booking.bookings SET status = 'cancelled' WHERE id = $1`, [result.bookingId]);

      const url = await callbackLocation(reference);
      expect(url.searchParams.get('status')).toBe('refunded');
      expect(url.searchParams.get('reason')).toBeNull();
    });
  });
});
