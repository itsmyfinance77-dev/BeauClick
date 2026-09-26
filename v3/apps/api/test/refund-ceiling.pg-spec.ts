import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { OrderService } from '@beauclick/commerce';
import { PaymentService, RefundEntity, RefundStatus, SandboxPaymentProvider } from '@beauclick/payment';

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
 * #322: a refund may never give back more than the payment captured, and the
 * service that OWNS refunds is the one that refuses it -- before the gateway
 * is asked and before anything is recorded.
 *
 * Until #322 only commerce's projection enforced this (`REFUND_EXCEEDS_ORDER`,
 * `refunded_total + amount <= collected_total`). Payment would record a 500-
 * Toman refund of a 400-Toman capture as `succeeded`, emit `RefundCompleted`
 * for 500, and commerce would refuse the same refund: two stores contradicting
 * each other by the full amount, and an event the projection can never accept.
 *
 * Real PostgreSQL and the real sandbox gateway throughout, because the two
 * properties that matter -- the ceiling holding under CONCURRENT refunds, and
 * payment and commerce agreeing afterwards -- are both properties of the
 * database, not of the service's arithmetic.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Refund ceiling on real PostgreSQL (#322)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;
  let orders: OrderService;
  let payments: PaymentService;
  let relay: { drain: () => Promise<{ dispatched: number; failed: number }> };

  /** Two hops to commerce (payment outbox, then commerce's): drain until quiet. */
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
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
    orders = app.get(OrderService);
    payments = app.get(PaymentService);
    relay = ctx.relay;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    jest.restoreAllMocks();
  });

  let seq = 0;
  /** A booking paid in full through the sandbox gateway, projected into commerce. */
  async function capturedOrder(priceToman = 400_000) {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+98942${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98943${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سقف بازگشت', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(200 + seq));
    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
    });
    const [attempt] = await dataSource.query(
      `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
      [result.paymentIntentId],
    );
    const reference = attempt.provider_reference as string;
    await sandbox.decide(reference, 'success');
    await checkout.handleCallback('sandbox', reference, { reference });
    await drainUntilQuiet();

    const orderId = result.order.order.id;
    const intentId = result.paymentIntentId as string;
    expect(intentId).toBeTruthy();
    expect((await orders.findById(orderId))?.collectedTotalToman).toBe(priceToman);
    return { orderId, intentId, reference, totalToman: result.order.order.totalToman as number };
  }

  const refund = (orderId: string, amountToman: number, requestKey: string) =>
    payments.refund({ orderId, amountToman, reason: 'آزمون سقف بازگشت', requestKey, actorType: 'system', actorId: null });

  const exceeds = (requestedToman: number, refundableToman: number) => ({
    code: 'REFUND_EXCEEDS_CAPTURED',
    details: { requestedToman, refundableToman },
  });

  async function refundRows(orderId: string) {
    return dataSource.query(
      `SELECT request_key, amount_toman::int AS amount, status, kind FROM payment.refunds WHERE order_id = $1 ORDER BY id`,
      [orderId],
    ) as Promise<Array<{ request_key: string; amount: number; status: RefundStatus; kind: string }>>;
  }

  async function refundEvents(orderId: string): Promise<number> {
    const [{ n }] = await dataSource.query(
      `SELECT count(*)::int AS n FROM payment.outbox_events WHERE event_type = 'RefundCompleted' AND payload->>'orderId' = $1`,
      [orderId],
    );
    return n;
  }

  /** Payment's own statement of what went back, for comparison with commerce's. */
  async function paymentRefunded(orderId: string): Promise<number> {
    const [{ total }] = await dataSource.query(
      `SELECT COALESCE(SUM(amount_toman), 0)::int AS total FROM payment.refunds WHERE order_id = $1 AND kind = 'order' AND status = 'succeeded'`,
      [orderId],
    );
    return total;
  }

  describe('a refund above the capture', () => {
    it('is refused before the gateway is asked, and leaves no refund row and no event (the issue’s 400 → 500)', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      await expect(refund(orderId, 500_000, 'over')).rejects.toMatchObject(exceeds(500_000, 400_000));

      expect(gateway).not.toHaveBeenCalled();
      expect(await refundRows(orderId)).toEqual([]);
      expect(await refundEvents(orderId)).toBe(0);
      await drainUntilQuiet();
      const order = await orders.findById(orderId);
      expect(order?.refundedTotalToman).toBe(0);
      expect(order?.status).toBe('paid');
    });

    it('lets a refund of exactly the capture through the gateway, and commerce agrees with payment', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      const done = await refund(orderId, 400_000, 'full');
      expect(done.status).toBe('succeeded');
      expect(gateway).toHaveBeenCalledTimes(1);

      await drainUntilQuiet();
      const order = await orders.findById(orderId);
      expect(order?.refundedTotalToman).toBe(400_000);
      expect(order?.status).toBe('refunded');
      expect(await paymentRefunded(orderId)).toBe(400_000);
    });
  });

  describe('earlier refunds count against the capture', () => {
    it('refuses the partial refund that would cross it, allows the one that reaches it, and ends where commerce ends', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      expect((await refund(orderId, 100_000, 'part-1')).status).toBe('succeeded');
      expect((await refund(orderId, 200_000, 'part-2')).status).toBe('succeeded');
      await drainUntilQuiet();
      expect((await orders.findById(orderId))?.status).toBe('partially_refunded');

      await expect(refund(orderId, 150_000, 'part-3')).rejects.toMatchObject(exceeds(150_000, 100_000));
      expect((await refund(orderId, 100_000, 'part-4')).status).toBe('succeeded');
      await expect(refund(orderId, 1, 'part-5')).rejects.toMatchObject(exceeds(1, 0));

      // The gateway saw exactly the three refunds that fit, and no others.
      expect(gateway.mock.calls.map(([request]) => request.amountToman)).toEqual([100_000, 200_000, 100_000]);

      await drainUntilQuiet();
      const order = await orders.findById(orderId);
      expect(order?.refundedTotalToman).toBe(400_000);
      expect(order?.status).toBe('refunded');
      expect(await paymentRefunded(orderId)).toBe(order?.refundedTotalToman);
      expect((await refundRows(orderId)).map((r) => r.request_key)).toEqual(['part-1', 'part-2', 'part-4']);
    });

    it('returns an accepted refund on replay even once the capture is used up — a replay is not a second refund', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      const first = await refund(orderId, 400_000, 'once');
      const replay = await refund(orderId, 400_000, 'once');

      expect(replay.id).toBe(first.id);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(await refundRows(orderId)).toHaveLength(1);
    });

    /*
     * What counts as committed, stated with rows written directly -- the
     * gateway states a sandbox transaction cannot be steered into after a
     * success. `pending` is a refund whose gateway call is still in flight;
     * `manual_required` is money going back by hand; `failed` is money that
     * never left.
     */
    async function withEarlierRefund(status: RefundStatus, amountToman: number) {
      const fixture = await capturedOrder(400_000);
      await dataSource.getRepository(RefundEntity).insert({
        id: uuidv7(),
        orderId: fixture.orderId,
        paymentIntentId: fixture.intentId,
        paymentAttemptId: null,
        requestKey: `earlier-${status}`,
        amountToman,
        status,
        kind: 'order',
        providerRefundReference: null,
        failureCode: status === 'failed' ? 'declined' : null,
        reason: 'ردیف پیشین',
        requestedByActorType: 'system',
        requestedByActorId: null,
        completedAt: status === 'pending' ? null : new Date(),
      });
      return fixture;
    }

    const counted: Array<[RefundStatus, string]> = [
      ['pending', 'its gateway call may still move the money'],
      ['manual_required', 'the money still goes back, by hand'],
    ];
    it.each(counted)('counts an earlier %s refund (%s)', async (status) => {
      const { orderId } = await withEarlierRefund(status, 300_000);
      await expect(refund(orderId, 200_000, 'after')).rejects.toMatchObject(exceeds(200_000, 100_000));
      expect((await refund(orderId, 100_000, 'after-fits')).status).toBe('succeeded');
    });

    it('does not count an earlier failed refund — that money never left', async () => {
      const { orderId } = await withEarlierRefund('failed', 400_000);
      expect((await refund(orderId, 400_000, 'after-failure')).status).toBe('succeeded');
    });
  });

  describe('under concurrency', () => {
    /*
     * The deterministic form of the race. Another refund of the same payment
     * is part-way through its check-and-insert: it holds the payment's lock
     * and has written a `pending` 300 000 it has not committed yet. A refund
     * started now must WAIT for it and then see it. Without the lock it would
     * not wait, would not see the uncommitted row, and would send 200 000 on
     * top -- 500 000 out of a 400 000 capture.
     */
    it('makes a refund wait for one in flight on the same payment, then measures it against that one', async () => {
      const { orderId, intentId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      const inFlight = dataSource.createQueryRunner();
      await inFlight.connect();
      await inFlight.startTransaction();
      let racing: Promise<RefundEntity> | null = null;
      try {
        await inFlight.query(`SELECT id FROM payment.payment_intents WHERE id = $1 FOR UPDATE`, [intentId]);
        await inFlight.manager.insert(RefundEntity, {
          id: uuidv7(),
          orderId,
          paymentIntentId: intentId,
          paymentAttemptId: null,
          requestKey: 'in-flight',
          amountToman: 300_000,
          status: 'pending',
          kind: 'order',
          providerRefundReference: null,
          failureCode: null,
          reason: 'در جریان',
          requestedByActorType: 'system',
          requestedByActorId: null,
          completedAt: null,
        });

        let finished = false;
        racing = refund(orderId, 200_000, 'racing');
        void racing.then(
          () => (finished = true),
          () => (finished = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Still waiting on the lock, and nothing sent to the gateway.
        expect(finished).toBe(false);
        expect(gateway).not.toHaveBeenCalled();

        await inFlight.commitTransaction();
      } finally {
        if (inFlight.isTransactionActive) await inFlight.rollbackTransaction();
        await inFlight.release();
      }

      await expect(racing).rejects.toMatchObject(exceeds(200_000, 100_000));
      expect(gateway).not.toHaveBeenCalled();
    });

    it('never lets concurrent refunds of one payment add up past the capture', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => refund(orderId, 150_000, `concurrent-${i}`)),
      );

      const accepted = settled.filter((s) => s.status === 'fulfilled');
      const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      // 150 000 fits twice into 400 000, and a third would reach 450 000.
      expect(accepted).toHaveLength(2);
      expect(refused).toHaveLength(4);
      for (const r of refused) expect(r.reason).toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED' });
      expect(gateway).toHaveBeenCalledTimes(2);

      await drainUntilQuiet();
      const order = await orders.findById(orderId);
      expect(order?.refundedTotalToman).toBe(300_000);
      expect(await paymentRefunded(orderId)).toBe(300_000);
    });

    it('turns concurrent calls under ONE key into one refund, none of them refused', async () => {
      const { orderId } = await capturedOrder(400_000);
      const gateway = jest.spyOn(sandbox, 'refund');

      // `allSettled`, not `all`: every call finishes inside this test even if
      // one is refused, so none is still writing when the next test truncates.
      const settled = await Promise.allSettled(Array.from({ length: 4 }, () => refund(orderId, 400_000, 'same-key')));

      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      const results = settled.map((s) => (s as PromiseFulfilledResult<RefundEntity>).value);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await refundRows(orderId)).toHaveLength(1);
      expect(gateway).toHaveBeenCalledTimes(1);
    });
  });

  describe('a duplicate-charge correction', () => {
    /** A genuine second charge on an already-paid order, as `payment-security.pg-spec.ts` stages it. */
    async function duplicateCharge() {
      const fixture = await capturedOrder(400_000);
      const secondReference = `SECOND-CHARGE-${seq}`;
      await dataSource.query(
        `INSERT INTO payment.sandbox_transactions (reference, amount_toman, outcome, settlement_reference)
         VALUES ($1, $2, 'paid', $3)`,
        [secondReference, fixture.totalToman, `TX-${secondReference}`],
      );
      const [{ id }] = await dataSource.query(
        `INSERT INTO payment.payment_attempts (id, payment_intent_id, provider_key, provider_reference, status, requested_amount_toman)
         VALUES (gen_random_uuid(), $1, 'sandbox', $2, 'initiated', $3) RETURNING id`,
        [fixture.intentId, secondReference, fixture.totalToman],
      );
      const callback = await checkout.handleCallback('sandbox', secondReference, { reference: secondReference });
      expect(callback.duplicateChargeRefunded).toBe(true);
      await drainUntilQuiet();
      return { ...fixture, duplicateAttemptId: id as string };
    }

    it('is measured against its own attempt’s capture: a second correction of the same charge is refused', async () => {
      const { orderId, duplicateAttemptId } = await duplicateCharge();

      await expect(
        payments.refund({
          orderId,
          amountToman: 1,
          reason: 'دوباره',
          requestKey: 'duplicate-again',
          actorType: 'system',
          actorId: null,
          kind: 'duplicate_charge',
          paymentAttemptId: duplicateAttemptId,
        }),
      ).rejects.toMatchObject(exceeds(1, 0));
    });

    it('does not use up the order’s own capture — the order can still be refunded in full', async () => {
      const { orderId } = await duplicateCharge();

      expect((await refund(orderId, 400_000, 'order-full')).status).toBe('succeeded');
      await drainUntilQuiet();
      expect((await orders.findById(orderId))?.refundedTotalToman).toBe(400_000);
    });
  });
});
