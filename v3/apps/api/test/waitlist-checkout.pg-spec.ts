import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BookingService } from '@beauclick/booking';
import { OutboxRelay } from '@beauclick/events';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { WaitlistService } from '@beauclick/waitlist';
import {
  BookingOutcomePolicyService,
  CustomerPolicyCopyService,
  OutcomePolicyAssignmentService,
} from '@beauclick/commercial-policy';
import { BookingOutcomeAcceptanceV1, BookingOutcomePolicyVersionTermsV1 } from '@beauclick/commercial-policy-contract';

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

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * REAL PostgreSQL: demo remediation F-8 -- accepting a waitlist offer is a
 * real checkout.
 *
 * Before the fix `POST /v1/waitlist/:id/accept` created a bare `pending`
 * booking: no order, no acceptance snapshot, no payment intent -- nothing to
 * pay, so the hold just lapsed. Acceptance now runs THROUGH
 * `CheckoutService.checkout` with the offer CAS as its entitling claim, so the
 * terms acceptance, order, intent, hold/expiry, callback and the late-capture
 * refund are the ordinary checkout's own.
 */
describePg('Waitlist acceptance through checkout (demo F-8, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let waitlist: WaitlistService;
  let checkout: CheckoutService;
  let relay: OutboxRelay;
  let sandbox: SandboxPaymentProvider;
  let admin: SeededUser;

  let sequence = 0;
  const nextPhone = () => `+98912${String(3000000 + (sequence += 1)).slice(-7)}`;
  const nextKey = (p: string) => `${p}-${(sequence += 1)}-${Date.now() % 100000}`;
  const auth = (u: SeededUser) => ({ Authorization: `Bearer ${u.accessToken}` });

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    waitlist = app.get(WaitlistService);
    checkout = app.get(CheckoutService);
    relay = ctx.relay;
    sandbox = app.get(SandboxPaymentProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  /** A professional, a slot, two waiters; the slot is booked and cancelled so the FIRST waiter holds a live offer. */
  async function offered(priceToman = 250_000) {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72));
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const second = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const entry = await waitlist.join({ customerId: customer.id, professionalId: professional.id, serviceId: professional.serviceId });
    await new Promise((r) => setTimeout(r, 5));
    const secondEntry = await waitlist.join({ customerId: second.id, professionalId: professional.id, serviceId: professional.serviceId });

    const holder = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const held = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
    await bookings.cancel(held.id, { type: 'customer', id: holder.id }, null);
    await relay.drain();
    expect((await waitlist.findById(entry.id))?.status).toBe('offered');
    return { owner, professional, slotId, customer, second, entry, secondEntry };
  }

  const accept = (user: SeededUser, entryId: string, key: string | null = uuidv7(), body: Record<string, unknown> = {}) => {
    const req = request(app.getHttpServer()).post(`/api/v1/waitlist/${entryId}/accept`).set(auth(user));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const counts = async () => {
    const [row] = await dataSource.query(
      `SELECT (SELECT COUNT(*)::int FROM booking.bookings WHERE status IN ('pending','confirmed')) AS bookings,
              (SELECT COUNT(*)::int FROM commerce.orders) AS orders,
              (SELECT COUNT(*)::int FROM payment.payment_intents) AS intents`,
    );
    return row as { bookings: number; orders: number; intents: number };
  };

  const entryRow = async (id: string) =>
    (await dataSource.query(`SELECT status, resulting_booking_id FROM waitlist.entries WHERE id = $1`, [id]))[0] as {
      status: string;
      resulting_booking_id: string | null;
    };

  const referenceOf = async (intentId: string): Promise<string> =>
    (await dataSource.query(`SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`, [intentId]))[0]
      .provider_reference;

  describe('the order and payment exist', () => {
    it('accept -> pending booking + order + payment intent + bank redirect; entry accepted and linked', async () => {
      const s = await offered(250_000);
      const res = await accept(s.customer, s.entry.id).expect(201);

      expect(res.body.data.booking.status).toBe('pending');
      expect(res.body.data.booking.slotId).toBe(s.slotId);
      expect(res.body.data.order.totalToman).toBe(250_000);
      expect(res.body.data.payment.intentId).toEqual(expect.any(String));
      expect(res.body.data.payment.redirectUrl).toEqual(expect.any(String));

      expect(await entryRow(s.entry.id)).toEqual({ status: 'accepted', resulting_booking_id: res.body.data.booking.id });
      const [order] = await dataSource.query(`SELECT source_type, source_id, customer_id FROM commerce.orders`);
      expect(order).toEqual({ source_type: 'booking', source_id: res.body.data.booking.id, customer_id: s.customer.id });
      expect(await counts()).toEqual({ bookings: 1, orders: 1, intents: 1 });
    });

    it('payment success through the gateway callback confirms the booking', async () => {
      const s = await offered();
      const res = await accept(s.customer, s.entry.id).expect(201);
      const reference = await referenceOf(res.body.data.payment.intentId);
      await sandbox.decide(reference, 'success');
      await checkout.handleCallback('sandbox', reference, { reference });

      const [b] = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [res.body.data.booking.id]);
      expect(b.status).toBe('confirmed');
      const [o] = await dataSource.query(`SELECT status FROM commerce.orders`);
      expect(o.status).toBe('paid');
    });

    it('a declined card leaves the booking pending (payable again within the hold), nothing confirmed', async () => {
      const s = await offered();
      const res = await accept(s.customer, s.entry.id).expect(201);
      const reference = await referenceOf(res.body.data.payment.intentId);
      await sandbox.decide(reference, 'failure');
      await checkout.handleCallback('sandbox', reference, { reference });

      const [b] = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [res.body.data.booking.id]);
      expect(b.status).toBe('pending');
      expect(await entryRow(s.entry.id)).toEqual({ status: 'accepted', resulting_booking_id: res.body.data.booking.id });
    });
  });

  describe('idempotency and races', () => {
    it('a retry with the SAME key returns the same booking and order, and no second intent', async () => {
      const s = await offered();
      const key = uuidv7();
      const first = await accept(s.customer, s.entry.id, key).expect(201);
      const again = await accept(s.customer, s.entry.id, key).expect(201);

      expect(again.body.data.booking.id).toBe(first.body.data.booking.id);
      expect(again.body.data.order.id).toBe(first.body.data.order.id);
      expect(again.body.data.payment.intentId).toBe(first.body.data.payment.intentId);
      expect(await counts()).toEqual({ bookings: 1, orders: 1, intents: 1 });
    });

    it('a DIFFERENT key after acceptance is refused and changes nothing', async () => {
      const s = await offered();
      await accept(s.customer, s.entry.id).expect(201);
      const before = await counts();
      const res = await accept(s.customer, s.entry.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('OFFER_NOT_AVAILABLE');
      expect(await counts()).toEqual(before);
    });

    it('two concurrent accepts with the same key converge on ONE booking/order/intent', async () => {
      const s = await offered();
      const key = uuidv7();
      const [a, b] = await Promise.all([accept(s.customer, s.entry.id, key), accept(s.customer, s.entry.id, key)]);
      const ok = [a, b].filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of ok) expect(r.body.data.booking.id).toBe(ok[0].body.data.booking.id);
      expect(await counts()).toEqual({ bookings: 1, orders: 1, intents: 1 });
    });

    it('the Idempotency-Key header is required (400) and nothing is consumed', async () => {
      const s = await offered();
      const res = await accept(s.customer, s.entry.id, null).expect(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await entryRow(s.entry.id)).status).toBe('offered');
      expect(await counts()).toEqual({ bookings: 0, orders: 0, intents: 0 });
    });

    it('a faster direct customer wins the slot: the waiter gets SLOT_UNAVAILABLE, entry missed, no order', async () => {
      const s = await offered();
      const racer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await bookings.create({ customerId: racer.id, professionalId: s.professional.id, slotId: s.slotId, serviceId: s.professional.serviceId });
      const res = await accept(s.customer, s.entry.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect((await entryRow(s.entry.id)).status).toBe('missed');
      const [{ n }] = await dataSource.query(`SELECT COUNT(*)::int AS n FROM commerce.orders`);
      expect(n).toBe(0);
    });
  });

  describe('ownership (authorization evidence: owner control, authenticated requester, target unchanged)', () => {
    it('another customer gets the non-enumerating 404; the owner then succeeds', async () => {
      const s = await offered();
      const res = await accept(s.second, s.entry.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      expect((await entryRow(s.entry.id)).status).toBe('offered');
      expect(await counts()).toEqual({ bookings: 0, orders: 0, intents: 0 });

      await accept(s.customer, s.entry.id).expect(201);
    });
  });

  describe('hold expiry and late capture', () => {
    it('an unpaid hold lapses: booking expired, slot reopened, the NEXT waiter is offered', async () => {
      const s = await offered();
      const res = await accept(s.customer, s.entry.id).expect(201);
      await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [res.body.data.booking.id]);
      await dataSource.query(`UPDATE booking.availability_slots SET held_until = now() - interval '1 minute' WHERE id = $1`, [s.slotId]);
      await bookings.expireStaleHolds();
      await relay.drain();

      const [b] = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [res.body.data.booking.id]);
      expect(b.status).toBe('expired');
      // Owner choice #4 default: the accepted entry stays accepted, linked to its lapsed booking.
      expect(await entryRow(s.entry.id)).toEqual({ status: 'accepted', resulting_booking_id: res.body.data.booking.id });
      const next = await waitlist.findById(s.secondEntry.id);
      expect(next?.status).toBe('offered');
      expect(next?.offeredSlotId).toBe(s.slotId);
    });

    it('capture after the slot went to someone else: payment stands, booking NOT confirmed, refund issued', async () => {
      const s = await offered();
      const res = await accept(s.customer, s.entry.id).expect(201);
      const bookingId = res.body.data.booking.id;
      const reference = await referenceOf(res.body.data.payment.intentId);
      // The hold lapses and a direct customer takes the slot while the waiter is at the bank.
      await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [bookingId]);
      await dataSource.query(`UPDATE booking.availability_slots SET held_until = now() - interval '1 minute' WHERE id = $1`, [s.slotId]);
      await bookings.expireStaleHolds();
      const racer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await bookings.create({ customerId: racer.id, professionalId: s.professional.id, slotId: s.slotId, serviceId: s.professional.serviceId });

      await sandbox.decide(reference, 'success');
      await checkout.handleCallback('sandbox', reference, { reference });
      await relay.drain();

      const [b] = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [bookingId]);
      expect(b.status).not.toBe('confirmed');
      const refunds = await dataSource.query(
        `SELECT r.status FROM payment.refunds r JOIN payment.payment_intents i ON i.id = r.payment_intent_id WHERE i.id = $1`,
        [res.body.data.payment.intentId],
      );
      expect(refunds.length).toBe(1);
    });
  });

  describe('terms acceptance (governed seller)', () => {
    const terms = (): BookingOutcomePolicyVersionTermsV1 => ({
      contractVersion: 1,
      cutoffHoursAllowed: [6, 12, 48],
      lateRetentionOptions: [{ kind: 'none' }, { kind: 'full_collected' }],
      noShowGraceMinutesAllowed: [5, 10, 30],
      noShowRetentionOptions: [{ kind: 'none' }],
      rescheduleFreeCountBeforeCutoff: 1,
      disputeWindowHours: 36,
      bodilyHarmWindowHours: 96,
      appealWindowHours: 48,
      caseFileRetentionDays: null,
      legalCap: null,
    });

    async function govern(owner: SeededUser): Promise<BookingOutcomeAcceptanceV1> {
      const outcomes = app.get(BookingOutcomePolicyService);
      const copies = app.get(CustomerPolicyCopyService);
      const assignments = app.get(OutcomePolicyAssignmentService);
      const key = nextKey('op');
      await outcomes.createPolicy(admin.id, key, `${key} display`, 'suite setup');
      const drafted = await outcomes.createVersionDraft(admin.id, { policyKey: key, terms: terms(), legalEvidenceKey: null, activationEndsAt: null }, 'suite setup');
      await outcomes.publishVersion(admin.id, key, drafted.version.version, 'suite setup');
      const copyKey = nextKey('cc');
      await copies.createCopy(admin.id, copyKey, 'suite copy', 'suite setup');
      const copy = await copies.createVersionDraft(
        admin.id,
        { copyKey, terms: { contractVersion: 1, locale: 'fa-IR', body: 'متن نمونهٔ سوئیت — نه متن حقوقی تأییدشده' }, activationEndsAt: null },
        'suite setup',
      );
      await copies.publishVersion(admin.id, copyKey, copy.version, 'suite setup');
      const refs = await request(app.getHttpServer()).get('/api/v1/me/subscriptions').set(auth(owner)).expect(200);
      const workspaceRef = refs.body.data.items[0].workspaceRef as string;
      await assignments.assign(owner.id, {
        workspaceRef,
        policyKey: key,
        selection: { cutoffHours: 12, lateCancellationRetention: { kind: 'none' }, noShowGraceMinutes: 10, noShowRetention: { kind: 'none' } },
        reason: 'suite choice',
      });
      return { policyKey: key, policyVersion: drafted.version.version, copyKey, copyVersion: copy.version };
    }

    it('without the current terms: 409 SERVICE_UNAVAILABLE_FOR_SALE and NOTHING consumed; with them: order + terms snapshot', async () => {
      const s = await offered();
      const acceptance = await govern(s.owner);

      const refused = await accept(s.customer, s.entry.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('SERVICE_UNAVAILABLE_FOR_SALE');
      const stale = await accept(s.customer, s.entry.id, uuidv7(), { acceptedPolicy: { ...acceptance, policyVersion: acceptance.policyVersion + 1 } });
      expect(stale.status).toBe(409);
      expect((await entryRow(s.entry.id)).status).toBe('offered');
      expect(await counts()).toEqual({ bookings: 0, orders: 0, intents: 0 });
      const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [s.slotId]);
      expect(slot.status).toBe('open');

      const ok = await accept(s.customer, s.entry.id, uuidv7(), { acceptedPolicy: acceptance }).expect(201);
      const [{ n }] = await dataSource.query(`SELECT COUNT(*)::int AS n FROM commerce.order_outcome_terms WHERE order_id = $1`, [ok.body.data.order.id]);
      expect(n).toBe(1);
    });
  });
});
