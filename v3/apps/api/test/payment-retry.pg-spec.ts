import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { OrderService } from '@beauclick/commerce';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { CheckoutService } from '../src/checkout/checkout.service';

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

/**
 * The order-scoped payment retry command (V3.1 Phase F design).
 *
 * `POST /v1/orders/:id/payment/retry` is the only thing in this platform that
 * can send a customer back to a bank for an order that already failed once, so
 * the question this suite exists to answer is the narrow one:
 *
 *   **Can anything other than a genuinely retryable, still-owed, still-owned,
 *   not-in-flight payment produce a redirect?**
 *
 * Every case below attacks that from a different direction. The property that
 * matters most is the fifth `describe`: a payment whose verification came back
 * `unknown` leaves the intent's stored failure code untouched — so a retry
 * decision made on the failure code ALONE would offer to charge a customer
 * again for a payment that may already have taken their money.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Order-scoped payment retry on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let orders: OrderService;
  let sandbox: SandboxPaymentProvider;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    orders = app.get(OrderService);
    sandbox = app.get(SandboxPaymentProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const CALLBACK_BASE = 'http://localhost:3099/api/v1/payments/callback';

  let seq = 0;

  interface Booked {
    customer: SeededUser;
    orderId: string;
    intentId: string;
    reference: string;
  }

  async function book(priceToman = 200_000): Promise<Booked> {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+98931${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98932${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(96 + seq));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: CALLBACK_BASE,
    });

    const [{ provider_reference: reference }] = await dataSource.query(
      `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
      [result.paymentIntentId],
    );

    return { customer, orderId: result.order.order.id, intentId: result.paymentIntentId, reference };
  }

  /** Drives a booking to a definitively FAILED payment with the given sandbox decision. */
  async function failWith(decision: 'failure' | 'cancel'): Promise<Booked> {
    const booked = await book();
    await sandbox.decide(booked.reference, decision);
    const callback = await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
    expect(callback.outcome.status).toBe('failed');
    return booked;
  }

  async function openAttempts(intentId: string): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payment.payment_attempts WHERE payment_intent_id = $1 AND status = 'initiated'`,
      [intentId],
    );
    return count as number;
  }

  // Returns supertest's own chainable Test, so a caller can `.expect(201)` on
  // it. Declared without `async` deliberately: an async wrapper would resolve
  // it to a plain Response and lose the assertion chain.
  function retryOverHttp(orderId: string, user: SeededUser) {
    return request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/payment/retry`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send();
  }

  // -------------------------------------------------------------------------

  describe('the four retryable failures', () => {
    it.each([
      ['a bank decline', 'failure' as const],
      ['a customer cancelling at the bank', 'cancel' as const],
    ])('%s produces a fresh gateway transaction', async (_label, decision) => {
      const booked = await failWith(decision);
      expect(await openAttempts(booked.intentId)).toBe(0);

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(201);
      const body = response.body.data as { redirectUrl: string };

      expect(typeof body.redirectUrl).toBe('string');
      expect(body.redirectUrl.length).toBeGreaterThan(0);
      // Exactly ONE new chargeable transaction, against the SAME intent -- a
      // second intent would be a second claim on the same order.
      expect(await openAttempts(booked.intentId)).toBe(1);
      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM payment.payment_intents WHERE order_id = $1`,
        [booked.orderId],
      );
      expect(count).toBe(1);
    });

    it('leads to a real settlement when the customer completes it', async () => {
      // The end-to-end property: a retry is not a separate payment flow, it is
      // the same one, so everything downstream of it must still work.
      const booked = await failWith('failure');
      await retryOverHttp(booked.orderId, booked.customer).expect(201);

      const [{ provider_reference: retryReference }] = await dataSource.query(
        `SELECT provider_reference FROM payment.payment_attempts
          WHERE payment_intent_id = $1 AND status = 'initiated'`,
        [booked.intentId],
      );
      await sandbox.decide(retryReference, 'success');
      const callback = await checkout.handleCallback('sandbox', retryReference, { reference: retryReference });

      expect(callback.outcome.status).toBe('succeeded');
      expect((await orders.findById(booked.orderId))?.status).toBe('paid');
    });

    it('does not accept a client claim that the failure was retryable', async () => {
      // `amount_mismatch` is refused BECAUSE OF THE STORED CODE. A caller
      // asserting otherwise in the body, the query string, or a header changes
      // nothing -- the server never reads any of them.
      const booked = await book();
      await sandbox.decide(booked.reference, 'success');
      await dataSource.query(`UPDATE payment.sandbox_transactions SET amount_toman = 1 WHERE reference = $1`, [
        booked.reference,
      ]);
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/orders/${booked.orderId}/payment/retry?reason=declined`)
        .set('Authorization', `Bearer ${booked.customer.accessToken}`)
        .send({ reason: 'declined', retryable: true })
        .expect(409);

      expect(response.body.error.code).toBe('PAYMENT_RETRY_NOT_AVAILABLE');
      expect(response.body.error.details.reason).toBe('not_retryable');
      expect(await openAttempts(booked.intentId)).toBe(0);
    });
  });

  describe('ownership', () => {
    it('refuses another customer, indistinguishably from a missing order', async () => {
      const booked = await failWith('failure');
      const stranger = await seedUser(app, dataSource, `+98933${String(seq).padStart(7, '0')}`);

      const foreign = await retryOverHttp(booked.orderId, stranger).expect(404);
      const missing = await retryOverHttp('01a04a62-0000-7000-8000-000000000000', stranger).expect(404);

      // Identical bodies: this route must not reveal which order ids exist.
      expect(foreign.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      expect(foreign.body.error).toEqual(missing.body.error);
      // And nothing was started for the real order.
      expect(await openAttempts(booked.intentId)).toBe(0);
    });

    it('refuses an unauthenticated caller', async () => {
      const booked = await failWith('failure');
      await request(app.getHttpServer()).post(`/api/v1/orders/${booked.orderId}/payment/retry`).send().expect(401);
      expect(await openAttempts(booked.intentId)).toBe(0);
    });

    it('refuses a caller whose session is for a different user, even with a valid token', async () => {
      // The guard resolves the owner from the ORDER row, never from anything
      // the caller supplied.
      const a = await failWith('failure');
      const b = await failWith('failure');
      await retryOverHttp(a.orderId, b.customer).expect(404);
      expect(await openAttempts(a.intentId)).toBe(0);
    });
  });

  describe('an order that no longer owes money', () => {
    it('refuses a PAID order', async () => {
      const booked = await book();
      await sandbox.decide(booked.reference, 'success');
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      expect((await orders.findById(booked.orderId))?.status).toBe('paid');

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('order_not_payable');
      expect(await openAttempts(booked.intentId)).toBe(0);
    });

    it('refuses a REFUNDED order', async () => {
      const booked = await book();
      await sandbox.decide(booked.reference, 'success');
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      await dataSource.query(`UPDATE commerce.orders SET status = 'refunded' WHERE id = $1`, [booked.orderId]);

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('order_not_payable');
    });

    it('refuses a CANCELLED order', async () => {
      const booked = await failWith('failure');
      await dataSource.query(`UPDATE commerce.orders SET status = 'cancelled' WHERE id = $1`, [booked.orderId]);

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('order_not_payable');
      expect(await openAttempts(booked.intentId)).toBe(0);
    });
  });

  describe('the three non-retryable failures', () => {
    it('refuses an amount mismatch — an open security question, not a retry', async () => {
      const booked = await book();
      await sandbox.decide(booked.reference, 'success');
      await dataSource.query(`UPDATE payment.sandbox_transactions SET amount_toman = 1000 WHERE reference = $1`, [
        booked.reference,
      ]);
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('not_retryable');
    });

    it('refuses an unknown reference', async () => {
      const booked = await book();
      // The sandbox has no record of a reference it never issued, which is
      // what a forged callback also produces.
      const spy = jest.spyOn(sandbox, 'verify').mockResolvedValueOnce({
        outcome: 'failed',
        paidAmountToman: null,
        paidCurrency: null,
        providerTransactionId: null,
        failureCode: 'unknown_reference',
      });
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      spy.mockRestore();

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('not_retryable');
    });

    it('refuses an EXPIRED payment window', async () => {
      const booked = await failWith('failure');
      await dataSource.query(`UPDATE payment.payment_intents SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
        booked.intentId,
      ]);

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('expired');
      expect(await openAttempts(booked.intentId)).toBe(0);
    });
  });

  /**
   * The case this command is most likely to get wrong, and the reason the
   * decision is not made on the failure code alone.
   */
  describe('an unresolved verification', () => {
    it('is REFUSED, even though the intent still carries a retryable failure code', async () => {
      // 1. A genuine, definitively-failed payment. Retryable.
      const booked = await failWith('failure');
      const [before] = await dataSource.query(
        `SELECT status, failure_code FROM payment.payment_intents WHERE id = $1`,
        [booked.intentId],
      );
      expect(before.failure_code).toBe('declined');

      // 2. The customer retries and goes back to the bank.
      await retryOverHttp(booked.orderId, booked.customer).expect(201);
      const [{ provider_reference: retryReference }] = await dataSource.query(
        `SELECT provider_reference FROM payment.payment_attempts
          WHERE payment_intent_id = $1 AND status = 'initiated'`,
        [booked.intentId],
      );

      // 3. They pay, and the gateway never answers the verification.
      await sandbox.decide(retryReference, 'success');
      const spy = jest.spyOn(sandbox, 'verify').mockRejectedValueOnce(new Error('ETIMEDOUT gateway.example:443'));
      const callback = await checkout.handleCallback('sandbox', retryReference, { reference: retryReference });
      spy.mockRestore();
      expect(callback.outcome.status).toBe('unresolved');

      // The trap: an `unknown` verification writes NOTHING, so the intent's
      // stored failure code is STILL `declined` from step 1 -- and `declined`
      // is retryable. A decision made on the failure code alone would offer to
      // charge this customer a second time for a payment that may already have
      // taken their money.
      const [after] = await dataSource.query(
        `SELECT status, failure_code FROM payment.payment_intents WHERE id = $1`,
        [booked.intentId],
      );
      expect(after.failure_code).toBe('declined');
      expect(after.status).toBe('pending');

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('verification_pending');
      // And no second chargeable transaction was opened.
      expect(await openAttempts(booked.intentId)).toBe(1);
    });

    it('is refused while a first payment is simply still in flight', async () => {
      // Same open-attempt signal, different cause: the customer is at the bank
      // right now. Indistinguishable from here, and correctly treated the same.
      const booked = await book();
      expect(await openAttempts(booked.intentId)).toBe(1);

      const response = await retryOverHttp(booked.orderId, booked.customer).expect(409);
      expect(response.body.error.details.reason).toBe('verification_pending');
      expect(await openAttempts(booked.intentId)).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('cannot be made to open two chargeable transactions by clicking twice', async () => {
      const booked = await failWith('failure');

      const responses = await Promise.all([
        retryOverHttp(booked.orderId, booked.customer),
        retryOverHttp(booked.orderId, booked.customer),
        retryOverHttp(booked.orderId, booked.customer),
      ]);

      // The safety property, asserted rather than a specific response mix:
      // whichever combination of 201s and 409s comes back, the database holds
      // exactly ONE open gateway transaction for this intent.
      expect(await openAttempts(booked.intentId)).toBe(1);

      // Every caller that succeeded was sent to the SAME transaction.
      const urls = responses
        .filter((r) => r.status === 201)
        .map((r) => (r.body.data as { redirectUrl: string }).redirectUrl);
      expect(urls.length).toBeGreaterThan(0);
      expect(new Set(urls).size).toBe(1);

      // Any refusal is the honest one, never a leak.
      for (const refused of responses.filter((r) => r.status !== 201)) {
        expect(refused.status).toBe(409);
        expect(refused.body.error.details.reason).toBe('verification_pending');
      }
    });

    it('still opens exactly one intent per order across sequential failures and retries', async () => {
      const booked = await failWith('failure');
      await retryOverHttp(booked.orderId, booked.customer).expect(201);

      const [{ provider_reference: second }] = await dataSource.query(
        `SELECT provider_reference FROM payment.payment_attempts
          WHERE payment_intent_id = $1 AND status = 'initiated'`,
        [booked.intentId],
      );
      await sandbox.decide(second, 'failure');
      await checkout.handleCallback('sandbox', second, { reference: second });
      await retryOverHttp(booked.orderId, booked.customer).expect(201);

      const [{ intents }] = await dataSource.query(
        `SELECT COUNT(*)::int AS intents FROM payment.payment_intents WHERE order_id = $1`,
        [booked.orderId],
      );
      expect(intents).toBe(1);
      expect(await openAttempts(booked.intentId)).toBe(1);
    });
  });

  describe('what the response is allowed to contain', () => {
    it('returns the redirect URL and nothing about the payment domain', async () => {
      const booked = await failWith('failure');
      const response = await retryOverHttp(booked.orderId, booked.customer).expect(201);
      const body = response.body.data as Record<string, unknown>;

      expect(Object.keys(body)).toEqual(['redirectUrl']);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(booked.intentId);
      expect(serialized).not.toContain('declined');
      expect(serialized).not.toContain('failure_code');
    });

    it('never publishes a provider failure code in a refusal', async () => {
      const booked = await book();
      const hostile = 'NOK merchant 1234-5678 rejected authority A0000000000000000000';
      const spy = jest.spyOn(sandbox, 'verify').mockResolvedValueOnce({
        outcome: 'failed',
        paidAmountToman: null,
        paidCurrency: null,
        providerTransactionId: null,
        failureCode: hostile,
      });
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      spy.mockRestore();

      // An unrecognised gateway code narrows to `gateway_error`, which IS
      // retryable -- so this one succeeds, and the assertion is that the
      // hostile string went nowhere near the response.
      const response = await retryOverHttp(booked.orderId, booked.customer).expect(201);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('merchant');
      expect(serialized).not.toContain('1234-5678');

      // Stored, though: that is what a support engineer gives the gateway's
      // own support desk.
      const [attempt] = await dataSource.query(
        `SELECT failure_code FROM payment.payment_attempts WHERE provider_reference = $1`,
        [booked.reference],
      );
      expect(attempt.failure_code).toBe(hostile.slice(0, 60));
    });

    it('refuses an order that never started a payment', async () => {
      seq += 1;
      const customer = await seedUser(app, dataSource, `+98934${String(seq).padStart(7, '0')}`);
      const orderId = '01a04a62-1111-7000-8000-000000000000';
      await dataSource.query(
        `INSERT INTO commerce.orders (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
                                      status, currency, subtotal_toman, discount_total_toman, fee_total_toman,
                                      total_toman, refunded_total_toman)
         VALUES ($1, 'direct', $2, $3, 'professional', $3, 'pending', 'IRT', 1000, 0, 0, 1000, 0)`,
        [orderId, orderId, customer.id],
      );

      const response = await retryOverHttp(orderId, customer).expect(409);
      expect(response.body.error.details.reason).toBe('no_payment_started');
    });
  });
});
