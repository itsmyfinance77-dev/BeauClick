import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { BookingService } from '@beauclick/booking';
import { OutboxRelay } from '@beauclick/events';
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

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * REAL PostgreSQL: demo remediation F-7 -- what the customer is told after a
 * payment that could not confirm the booking.
 *
 * Before: a capture landing on an order that had already LAPSED (hold expired,
 * order closed, nothing ever collected) took the duplicate-charge branch, and
 * the result page said "رزرو شما تأیید شد … پرداخت تکراری" -- false twice.
 * After: the same money path (the capture is refunded), classified as a
 * refund; and the redirect says "refunded" ONLY when the persisted refund row
 * is `succeeded` -- a `manual_required` (bank without a refund API) or pending
 * refund is `refund_pending`. A genuine second charge on a PAID order keeps its
 * own `duplicate_refunded` classification.
 */
describePg('Late capture classification (demo F-7, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;
  let relay: OutboxRelay;
  let seq = 0;
  const phone = () => `+98912${String(4000000 + (seq += 1)).slice(-7)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
    relay = ctx.relay;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  async function booked() {
    const owner = await seedUser(app, dataSource, phone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص', 300_000);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(60 + seq));
    const customer = await seedUser(app, dataSource, phone(), ['customer']);
    const result = await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, callbackBaseUrl: 'http://x/cb' });
    const [attempt] = await dataSource.query(`SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`, [result.paymentIntentId]);
    return { result, slotId, reference: attempt.provider_reference as string, orderId: result.order.order.id };
  }

  /** The hold lapses and the expiry is fully processed (booking expired, its order closed). */
  async function lapse(b: Awaited<ReturnType<typeof booked>>) {
    await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [b.result.bookingId]);
    await dataSource.query(`UPDATE booking.availability_slots SET held_until = now() - interval '1 minute' WHERE id = $1`, [b.slotId]);
    await bookings.expireStaleHolds();
    await relay.drain();
  }

  const callbackStatus = async (reference: string) => {
    const res = await request(app.getHttpServer()).get('/api/v1/payments/callback/sandbox').query({ reference }).expect(303);
    return new URL(res.headers.location as string).searchParams.get('status');
  };
  const refunds = (orderId: string) =>
    dataSource.query(`SELECT kind, status, reason FROM payment.refunds WHERE order_id = $1 ORDER BY created_at, id`, [orderId]);
  const orderStatus = async (orderId: string) => (await dataSource.query(`SELECT status FROM commerce.orders WHERE id = $1`, [orderId]))[0].status;
  const bookingStatus = async (id: string) => (await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [id]))[0].status;

  it('precondition: after the lapse the order is no longer payable and nothing was collected', async () => {
    const b = await booked();
    await lapse(b);
    expect(await bookingStatus(b.result.bookingId)).toBe('expired');
    expect(await orderStatus(b.orderId)).not.toBe('pending');
    const [{ collected }] = await dataSource.query(`SELECT collected_total_toman::int AS collected FROM commerce.orders WHERE id = $1`, [b.orderId]);
    expect(collected).toBe(0);
  });

  it('capture after the lapse: refunded (succeeded) → redirect "refunded", NOT "duplicate_refunded"; booking not confirmed', async () => {
    const b = await booked();
    await lapse(b);
    await sandbox.decide(b.reference, 'success');
    expect(await callbackStatus(b.reference)).toBe('refunded');
    const rows = await refunds(b.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].reason).toContain('پس از پایان مهلت رزرو');
    expect(await bookingStatus(b.result.bookingId)).toBe('expired');
  });

  it('same, on a simulated bank WITHOUT a refund API: refund manual_required → redirect "refund_pending" (never "refunded")', async () => {
    const b = await booked();
    await lapse(b);
    await sandbox.decide(b.reference, 'success_manual_refund');
    expect(await callbackStatus(b.reference)).toBe('refund_pending');
    const rows = await refunds(b.orderId);
    expect(rows.map((r: { status: string }) => r.status)).toEqual(['manual_required']);
  });

  it('control: capture before the lapse still confirms ("succeeded"), no refund', async () => {
    const b = await booked();
    await sandbox.decide(b.reference, 'success');
    expect(await callbackStatus(b.reference)).toBe('succeeded');
    expect(await bookingStatus(b.result.bookingId)).toBe('confirmed');
    expect(await refunds(b.orderId)).toEqual([]);
  });

  it('control: a genuine SECOND charge on a paid order keeps "duplicate_refunded" (refund succeeded)', async () => {
    const b = await booked();
    await sandbox.decide(b.reference, 'success');
    expect(await callbackStatus(b.reference)).toBe('succeeded');
    const second = 'MOCK-SECOND-CHARGE-F7';
    await dataSource.query(`INSERT INTO payment.sandbox_transactions (reference, amount_toman, outcome, settlement_reference) VALUES ($1, $2, 'paid', 'MOCKTX-F7')`, [
      second,
      b.result.order.order.totalToman,
    ]);
    await dataSource.query(
      `INSERT INTO payment.payment_attempts (id, payment_intent_id, provider_key, provider_reference, status, requested_amount_toman)
       VALUES (gen_random_uuid(), $1, 'sandbox', $2, 'initiated', $3)`,
      [b.result.paymentIntentId, second, b.result.order.order.totalToman],
    );
    expect(await callbackStatus(second)).toBe('duplicate_refunded');
    expect(await bookingStatus(b.result.bookingId)).toBe('confirmed');
    const dup = (await refunds(b.orderId)).filter((r: { kind: string }) => r.kind === 'duplicate_charge');
    expect(dup).toHaveLength(1);
    expect(dup[0].reason).toContain('پرداخت تکراری');
  });
});
