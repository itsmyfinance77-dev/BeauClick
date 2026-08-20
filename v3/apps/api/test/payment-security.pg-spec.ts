import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { BookingService } from '@beauclick/booking';
import { OrderService } from '@beauclick/commerce';
import { MockGatewayProvider, PaymentService, PaymentProviderRegistry } from '@beauclick/payment';
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
 * Payment callback security, against real PostgreSQL.
 *
 * The single question this suite exists to answer: **can anything other than
 * a real, gateway-confirmed payment ever mark an order paid?**
 *
 * Every test attacks that from a different direction -- a forged callback, a
 * replayed one, a tampered amount, an expired intent, an unknown reference,
 * a concurrent double-callback. The mock gateway keeps its own table and
 * `verify()` genuinely queries it, so a forged callback fails here for the
 * same structural reason it would against ZarinPal: the callback parameters
 * are never the evidence.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Payment callback security on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let payments: PaymentService;
  let orders: OrderService;
  let bookings: BookingService;
  let mock: MockGatewayProvider;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    payments = app.get(PaymentService);
    orders = app.get(OrderService);
    bookings = app.get(BookingService);
    mock = app.get(MockGatewayProvider);
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
    const owner = await seedUser(app, dataSource, `+98912${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98913${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48 + seq));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackUrl: 'http://localhost:3099/api/v1/payments/callback/mock',
    });

    const attempts = await dataSource.query(
      `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
      [result.paymentIntentId],
    );

    return { owner, customer, professional, slotId, result, reference: attempts[0]?.provider_reference as string };
  }

  describe('a forged callback proves nothing', () => {
    it('REFUSES to mark an order paid when the customer never actually paid', async () => {
      const { result, reference } = await bookAndReachGateway();

      // The customer never completed anything at the gateway; they simply
      // hit the success URL. The mock gateway's own record still says
      // 'pending', and verification asks IT, not the caller.
      const callback = await checkout.handleCallback('mock', reference, { reference, Status: 'OK', status: 'success' });

      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('not_completed');

      const order = await orders.findById(result.order.order.id);
      expect(order?.status).toBe('pending');
      expect(order?.paidAt).toBeNull();

      const booking = await bookings.findById(result.bookingId);
      expect(booking?.status).toBe('pending');
    });

    it('rejects a completely fabricated provider reference without leaking whether it exists', async () => {
      await bookAndReachGateway();
      await expect(
        checkout.handleCallback('mock', 'MOCK-DOES-NOT-EXIST', { reference: 'MOCK-DOES-NOT-EXIST', Status: 'OK' }),
      ).rejects.toMatchObject({ response: { code: 'NOT_FOUND_OR_NOT_YOURS' } });
    });

    it('ignores the callback parameters entirely when the gateway says the payment was DECLINED', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, false); // the bank declined

      const callback = await checkout.handleCallback('mock', reference, { reference, Status: 'OK', status: 'success' });

      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('declined');
      expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
    });
  });

  describe('amount tampering', () => {
    it('refuses to succeed when the gateway captured LESS than the order total', async () => {
      const { result, reference } = await bookAndReachGateway(200_000);
      await mock.settle(reference, true);

      // Simulate the gateway reporting a different captured amount than the
      // intent recorded -- the exact shape of a tampered redirect or a
      // manipulated gateway-side amount.
      await dataSource.query(`UPDATE payment.mock_gateway_transactions SET amount_toman = 1000 WHERE reference = $1`, [reference]);

      const callback = await checkout.handleCallback('mock', reference, { reference });

      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('amount_mismatch');
      expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
      expect((await bookings.findById(result.bookingId))?.status).toBe('pending');
    });

    it('refuses to succeed when the gateway captured MORE than the order total', async () => {
      const { result, reference } = await bookAndReachGateway(200_000);
      await mock.settle(reference, true);
      await dataSource.query(`UPDATE payment.mock_gateway_transactions SET amount_toman = 999999 WHERE reference = $1`, [reference]);

      const callback = await checkout.handleCallback('mock', reference, { reference });
      expect(callback.outcome.status).toBe('failed');
      expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
    });

    it('compares against the amount captured at INTENT time, so mutating the order afterwards cannot launder a mismatch', async () => {
      const { result, reference } = await bookAndReachGateway(200_000);
      await mock.settle(reference, true);
      await dataSource.query(`UPDATE payment.mock_gateway_transactions SET amount_toman = 1000 WHERE reference = $1`, [reference]);

      // An attacker who could also lower the order total still fails: the
      // intent's own captured figure is what verification checks.
      await dataSource.query(
        `UPDATE commerce.orders SET subtotal_toman = 1000, total_toman = 1000 WHERE id = $1`,
        [result.order.order.id],
      );

      const callback = await checkout.handleCallback('mock', reference, { reference });
      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('amount_mismatch');
    });
  });

  describe('replay and duplicate delivery', () => {
    it('processes a duplicated callback exactly once', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, true);

      const first = await checkout.handleCallback('mock', reference, { reference });
      const second = await checkout.handleCallback('mock', reference, { reference });
      const third = await checkout.handleCallback('mock', reference, { reference });

      expect(first.outcome.status).toBe('succeeded');
      expect(second.outcome.status).toBe('replayed');
      expect(third.outcome.status).toBe('replayed');

      // Exactly one PaymentSucceeded, and exactly one OrderPaid. A second of
      // either becomes a second commission in the ledger.
      const [{ payments_count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS payments_count FROM payment.outbox_events WHERE event_type = 'PaymentSucceeded'`,
      );
      const [{ orders_count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS orders_count FROM commerce.outbox_events WHERE event_type = 'OrderPaid'`,
      );
      expect(payments_count).toBe(1);
      expect(orders_count).toBe(1);

      expect((await orders.findById(result.order.order.id))?.status).toBe('paid');
      expect((await bookings.findById(result.bookingId))?.status).toBe('confirmed');
    });

    it('processes SIMULTANEOUS duplicate callbacks exactly once', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, true);

      const results = await Promise.all([
        checkout.handleCallback('mock', reference, { reference }),
        checkout.handleCallback('mock', reference, { reference }),
        checkout.handleCallback('mock', reference, { reference }),
      ]);

      const succeeded = results.filter((r) => r.outcome.status === 'succeeded');
      expect(succeeded).toHaveLength(1);

      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM payment.outbox_events WHERE event_type = 'PaymentSucceeded'`,
      );
      expect(count).toBe(1);
      expect((await orders.findById(result.order.order.id))?.status).toBe('paid');
    });

    it('does not re-verify with the gateway on a replayed callback', async () => {
      const { reference } = await bookAndReachGateway();
      await mock.settle(reference, true);
      await checkout.handleCallback('mock', reference, { reference });

      const verifySpy = jest.spyOn(mock, 'verify');
      await checkout.handleCallback('mock', reference, { reference });
      // A replay short-circuits on the attempt's terminal status: talking to
      // the bank again would be a pointless external call, and for some
      // gateways a second verify is itself an error.
      expect(verifySpy).not.toHaveBeenCalled();
      verifySpy.mockRestore();
    });
  });

  describe('expiry', () => {
    it('refuses to verify an intent that has already expired', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, true);
      await dataSource.query(`UPDATE payment.payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
        result.paymentIntentId,
      ]);

      const callback = await checkout.handleCallback('mock', reference, { reference });
      expect(callback.outcome.status).toBe('failed');
      expect(callback.outcome.failureCode).toBe('intent_expired');
      expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
    });
  });

  describe('paid but unconfirmable -- the money must never be lost', () => {
    it('keeps the payment record and auto-refunds when the slot is gone', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, true);

      // While the customer was at the gateway, the hold lapsed and the
      // booking expired -- the slot may now belong to somebody else.
      await dataSource.query(`UPDATE booking.bookings SET status = 'expired', hold_expires_at = NULL WHERE id = $1`, [
        result.bookingId,
      ]);

      const callback = await checkout.handleCallback('mock', reference, { reference });

      // The payment DID happen and is recorded. Rolling it back would lose a
      // real charge.
      expect(callback.outcome.status).toBe('succeeded');
      expect(callback.refundIssued).toBe(true);
      const [attempt] = await dataSource.query(`SELECT status FROM payment.payment_attempts WHERE provider_reference = $1`, [reference]);
      expect(attempt.status).toBe('succeeded');

      // And the money went back.
      const refunds = await payments.listRefundsForOrder(result.order.order.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe('succeeded');
      expect(refunds[0].amountToman).toBe(200_000);
    });

    it('does not issue a SECOND refund when the same callback is replayed', async () => {
      const { result, reference } = await bookAndReachGateway();
      await mock.settle(reference, true);
      await dataSource.query(`UPDATE booking.bookings SET status = 'expired', hold_expires_at = NULL WHERE id = $1`, [
        result.bookingId,
      ]);

      await checkout.handleCallback('mock', reference, { reference });
      await checkout.handleCallback('mock', reference, { reference });

      const refunds = await payments.listRefundsForOrder(result.order.order.id);
      expect(refunds).toHaveLength(1);
    });
  });

  describe('the HTTP callback route itself', () => {
    it('is reachable without a session but still refuses to fabricate success', async () => {
      const { result, reference } = await bookAndReachGateway();

      const response = await request(app.getHttpServer())
        .get(`/api/v1/payments/callback/mock?reference=${reference}&Status=OK`)
        .expect(303);

      // Redirected to the failure result -- not "unauthorized", because the
      // gateway legitimately returns an anonymous browser here, and not
      // "success", because nothing was actually paid.
      expect(response.headers.location).toContain('status=failed');
      expect((await orders.findById(result.order.order.id))?.status).toBe('pending');
    });

    it('redirects with 303 so a refresh of the result page cannot re-submit', async () => {
      const { reference } = await bookAndReachGateway();
      await mock.settle(reference, true);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/payments/callback/mock`)
        .send({ reference })
        .expect(303);
      expect(response.headers.location).toContain('status=succeeded');
    });

    it('never lets a caller pay for an intent that is not theirs', async () => {
      const { result } = await bookAndReachGateway();
      const stranger = await seedUser(app, dataSource, '+989139999999');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/payments/intents/${result.paymentIntentId}/initiate`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(201);

      // No redirect URL is produced: an intent id alone is never authority
      // to pay, and the response shape is identical to a nonexistent intent.
      expect(response.body.data.redirectUrl).toBeNull();
    });
  });

  describe('the mock gateway is production-gated', () => {
    it('is enabled outside production', () => {
      expect(mock.isEnabled()).toBe(true);
      expect(app.get(PaymentProviderRegistry).enabledKeys()).toContain('mock');
    });

    it('fails CLOSED in production unless explicitly allowed', () => {
      // Constructed directly with a stub config rather than mutating
      // process.env on the running app: @nestjs/config caches a validated
      // snapshot of the environment at boot (AppModule uses
      // ConfigModule.forRoot({ validate })), so a late process.env change is
      // invisible to the live ConfigService. Testing the gate through that
      // cache would assert nothing about the gate's own logic.
      const gateWith = (env: Record<string, string>) =>
        new MockGatewayProvider(
          null as never,
          { get: (key: string) => env[key] } as never,
        ).isEnabled();

      expect(gateWith({ NODE_ENV: 'production' })).toBe(false);
      expect(gateWith({ NODE_ENV: 'production', PAYMENT_ALLOW_MOCK_GATEWAY: 'false' })).toBe(false);
      expect(gateWith({ NODE_ENV: 'production', PAYMENT_ALLOW_MOCK_GATEWAY: 'yes' })).toBe(false);
      expect(gateWith({ NODE_ENV: 'production', PAYMENT_ALLOW_MOCK_GATEWAY: 'true' })).toBe(true);
      // Unset NODE_ENV must not be treated as production-and-therefore-open,
      // nor as production-and-therefore-closed: development defaults open.
      expect(gateWith({})).toBe(true);
    });

    it('refuses an unknown provider key rather than silently falling back to another gateway', () => {
      const registry = app.get(PaymentProviderRegistry);
      expect(() => registry.get('zarinpal')).toThrow(/PAYMENT_PROVIDER_UNAVAILABLE|در دسترس نیست/);
    });
  });
});
