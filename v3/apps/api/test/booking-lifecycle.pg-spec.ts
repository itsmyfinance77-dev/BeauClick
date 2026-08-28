import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AvailabilityService, BookingService } from '@beauclick/booking';
import { assertNoLeak } from '@beauclick/testing';
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

const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Booking lifecycle, idempotency and authorization on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let availability: AvailabilityService;
  let checkout: CheckoutService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    availability = app.get(AvailabilityService);
    checkout = app.get(CheckoutService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  let seq = 0;
  async function scenario(priceToman = 200_000) {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+98912${String(seq).padStart(7, '0')}`, ['professional']);
    const customer = await seedUser(app, dataSource, `+98913${String(seq).padStart(7, '0')}`);
    const other = await seedUser(app, dataSource, `+98914${String(seq).padStart(7, '0')}`);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));
    const altSlotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(50));
    return { owner, customer, other, professional, slotId, altSlotId };
  }

  describe('the state machine', () => {
    it('runs the happy path pending -> confirmed -> completed', async () => {
      const { customer, professional, slotId, owner } = await scenario();
      const booking = await bookings.create({
        customerId: customer.id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
      });
      expect(booking.status).toBe('pending');

      expect(await bookings.confirm(booking.id)).toBe(true);
      expect((await bookings.findById(booking.id))?.status).toBe('confirmed');
      const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.status).toBe('booked');

      expect(await bookings.complete(booking.id, { type: 'professional', id: owner.id })).toBe(true);
      expect((await bookings.findById(booking.id))?.status).toBe('completed');
    });

    it('records every transition in an append-only history with a real actor', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await bookings.cancel(booking.id, { type: 'customer', id: customer.id }, 'تغییر برنامه');

      const history = await bookings.historyFor(booking.id);
      expect(history.map((h) => h.event)).toEqual(['created', 'cancelled']);
      expect(history[1].actorType).toBe('customer');
      expect(history[1].actorId).toBe(customer.id);
      expect(history[1].reason).toBe('تغییر برنامه');
      expect(history[1].fromStatus).toBe('pending');
      expect(history[1].toStatus).toBe('cancelled');
    });

    it('releases the slot on cancellation so another customer can book it', async () => {
      const { customer, other, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await bookings.cancel(booking.id, { type: 'customer', id: customer.id });

      const [slot] = await dataSource.query(`SELECT status, held_by_booking_id FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.status).toBe('open');
      expect(slot.held_by_booking_id).toBeNull();

      const rebooked = await bookings.create({ customerId: other.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      expect(rebooked.customerId).toBe(other.id);
    });

    it('expires an abandoned hold into its own terminal state, distinct from a cancellation', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [booking.id]);

      expect(await bookings.expireStaleHolds()).toBe(1);

      // `expired`, not `cancelled` with a reason string -- so "did a customer
      // cancel on us?" is answerable from the status column alone.
      expect((await bookings.findById(booking.id))?.status).toBe('expired');
      const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.status).toBe('open');
    });

    it('refuses to confirm a booking that is no longer pending, without throwing', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await bookings.cancel(booking.id, { type: 'customer', id: customer.id });

      // Must return false rather than throw: the payment path calls this
      // inside the transaction that recorded a real charge.
      expect(await bookings.confirm(booking.id)).toBe(false);
    });

    it('refuses to complete a booking that was never confirmed', async () => {
      const { customer, professional, slotId, owner } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await expect(bookings.complete(booking.id, { type: 'professional', id: owner.id })).rejects.toMatchObject({
        response: { code: 'INVALID_BOOKING_TRANSITION' },
      });
    });

    it('refuses a no-show before the slot has even ended', async () => {
      const { customer, professional, slotId, owner } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await bookings.confirm(booking.id);
      await expect(bookings.markNoShow(booking.id, { type: 'professional', id: owner.id })).rejects.toMatchObject({
        response: { code: 'INVALID_BOOKING_TRANSITION' },
      });
    });

    it('allows a no-show once the slot has passed', async () => {
      const { customer, professional, owner } = await scenario();
      const pastSlot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(200));
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId: pastSlot, serviceId: professional.serviceId });
      await bookings.confirm(booking.id);
      await dataSource.query(`UPDATE booking.bookings SET slot_end = now() - interval '1 hour' WHERE id = $1`, [booking.id]);

      expect(await bookings.markNoShow(booking.id, { type: 'professional', id: owner.id })).toBe(true);
      expect((await bookings.findById(booking.id))?.status).toBe('no_show');
    });

    it('enforces the concurrent-hold cap per customer', async () => {
      const { customer, professional } = await scenario();
      for (let i = 0; i < 5; i++) {
        const slot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(300 + i * 2));
        await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId: slot, serviceId: professional.serviceId });
      }
      const sixth = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(400));
      await expect(
        bookings.create({ customerId: customer.id, professionalId: professional.id, slotId: sixth, serviceId: professional.serviceId }),
      ).rejects.toMatchObject({ response: { code: 'TOO_MANY_ACTIVE_HOLDS' } });
    });
  });

  describe('rescheduling', () => {
    it('moves the booking, releases the old slot, and claims the new one', async () => {
      const { customer, professional, slotId, altSlotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      const moved = await bookings.reschedule(booking.id, altSlotId, { type: 'customer', id: customer.id }, 'زمان بهتر');

      expect(moved.slotId).toBe(altSlotId);
      expect(moved.rescheduleCount).toBe(1);
      const [oldSlot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      const [newSlot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [altSlotId]);
      expect(oldSlot.status).toBe('open');
      expect(newSlot.status).toBe('held');

      const history = await bookings.historyFor(booking.id);
      expect(history.at(-1)?.event).toBe('rescheduled');
      expect(history.at(-1)?.metadata).toMatchObject({ oldSlotId: slotId, newSlotId: altSlotId });
    });

    it('leaves the ORIGINAL booking untouched when the new slot cannot be claimed', async () => {
      const { customer, other, professional, slotId, altSlotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      // Somebody else takes the target slot first.
      await bookings.create({ customerId: other.id, professionalId: professional.id, slotId: altSlotId, serviceId: professional.serviceId });

      await expect(
        bookings.reschedule(booking.id, altSlotId, { type: 'customer', id: customer.id }),
      ).rejects.toMatchObject({ response: { code: 'SLOT_UNAVAILABLE' } });

      // A customer is never left without a booking because a race went the
      // wrong way.
      const unchanged = await bookings.findById(booking.id);
      expect(unchanged?.slotId).toBe(slotId);
      expect(unchanged?.status).toBe('pending');
      expect(unchanged?.rescheduleCount).toBe(0);
    });

    it('enforces the reschedule limit', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      const s2 = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(60));
      const s3 = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(62));
      const s4 = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(64));

      await bookings.reschedule(booking.id, s2, { type: 'customer', id: customer.id });
      await bookings.reschedule(booking.id, s3, { type: 'customer', id: customer.id });
      await expect(bookings.reschedule(booking.id, s4, { type: 'customer', id: customer.id })).rejects.toMatchObject({
        response: { code: 'RESCHEDULE_NOT_ALLOWED', details: { reason: 'max_reached' } },
      });
    });

    it('refuses a reschedule too close to the appointment', async () => {
      const { customer, professional, altSlotId } = await scenario();
      const soon = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(1));
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId: soon, serviceId: professional.serviceId });

      await expect(bookings.reschedule(booking.id, altSlotId, { type: 'customer', id: customer.id })).rejects.toMatchObject({
        response: { details: { reason: 'too_close' } },
      });
    });

    it("refuses a slot belonging to a different professional", async () => {
      const { customer, professional, slotId } = await scenario();
      const otherOwner = await seedUser(app, dataSource, '+989128888888', ['professional']);
      const otherProfessional = await seedProfessional(dataSource, otherOwner.id, 'دیگری');
      const foreignSlot = await seedSlot(dataSource, otherProfessional.id, otherProfessional.serviceId, futureSlotTime(70));

      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await expect(bookings.reschedule(booking.id, foreignSlot, { type: 'customer', id: customer.id })).rejects.toMatchObject({
        response: { details: { reason: 'invalid_slot' } },
      });
    });
  });

  describe('idempotency', () => {
    it('returns the SAME booking for a repeated idempotency key', async () => {
      const { customer, professional, slotId } = await scenario();
      const key = 'client-retry-key-1';

      const first = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key });
      const second = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key });

      expect(second.id).toBe(first.id);
      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM booking.bookings`);
      expect(count).toBe(1);
    });

    it('converges on ONE booking under concurrent identical retries', async () => {
      const { customer, professional, slotId } = await scenario();
      const key = 'double-click';

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key }),
        ),
      );

      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
    });

    it('scopes idempotency keys per customer, so one customer cannot replay another', async () => {
      const { customer, other, professional, slotId, altSlotId } = await scenario();
      const key = 'shared-string';

      const a = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key });
      const b = await bookings.create({ customerId: other.id, professionalId: professional.id, slotId: altSlotId, serviceId: professional.serviceId, idempotencyKey: key });

      expect(b.id).not.toBe(a.id);
      expect(b.customerId).toBe(other.id);
    });

    it('creates exactly ONE order for a booking, however many times checkout is retried', async () => {
      const { customer, professional, slotId } = await scenario();
      const key = 'checkout-retry';

      const first = await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key, callbackBaseUrl: 'http://x/cb' });
      const second = await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key, callbackBaseUrl: 'http://x/cb' });

      expect(second.bookingId).toBe(first.bookingId);
      expect(second.order.order.id).toBe(first.order.order.id);
      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM commerce.orders`);
      expect(count).toBe(1);
    });

    it('creates exactly ONE payment intent for an order, however many times checkout is retried', async () => {
      const { customer, professional, slotId } = await scenario();
      const key = 'intent-retry';
      await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key, callbackBaseUrl: 'http://x/cb' });
      await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, idempotencyKey: key, callbackBaseUrl: 'http://x/cb' });

      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM payment.payment_intents`);
      expect(count).toBe(1);
    });
  });

  describe('order creation and pricing integrity', () => {
    it('prices the order from the catalogue, never from the client', async () => {
      const { customer, professional, slotId } = await scenario(345_000);
      const result = await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, callbackBaseUrl: 'http://x/cb' });

      expect(result.order.order.subtotalToman).toBe(345_000);
      expect(result.order.order.totalToman).toBe(345_000);
      expect(result.order.items[0].unitPriceToman).toBe(345_000);
    });

    it('rejects a request that tries to smuggle a price field', async () => {
      const { customer, professional, slotId } = await scenario();
      const response = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId, priceToman: 1, totalToman: 1 })
        .expect(400);

      // forbidNonWhitelisted, not silent stripping: a caller who thought they
      // set a price learns they did not.
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM commerce.orders`);
      expect(count).toBe(0);
    });

    it("refuses to sell a service that does not belong to the named professional", async () => {
      const { customer, professional } = await scenario();
      const otherOwner = await seedUser(app, dataSource, '+989127777777', ['professional']);
      const otherProfessional = await seedProfessional(dataSource, otherOwner.id, 'دیگری');
      // A GENERIC slot (no service attached), so booking-service's own
      // slot/service check passes and the request reaches commerce -- which
      // is the layer this test is about.
      const genericSlot = await seedSlot(dataSource, professional.id, null, futureSlotTime(140));

      await expect(
        checkout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId: genericSlot,
          serviceId: otherProfessional.serviceId, // not theirs to sell
          callbackBaseUrl: 'http://x/cb',
        }),
      ).rejects.toMatchObject({ response: { code: 'SERVICE_UNAVAILABLE_FOR_SALE' } });

      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM booking.bookings`);
      expect(count).toBe(0);
    });

    it('rejects a service-specific slot booked for a DIFFERENT service, at the booking layer', async () => {
      const { customer, professional, slotId } = await scenario();
      const otherOwner = await seedUser(app, dataSource, '+989127777001', ['professional']);
      const otherProfessional = await seedProfessional(dataSource, otherOwner.id, 'دیگری');

      // Defence in depth: booking-service rejects this before commerce is
      // ever consulted, because the slot was published for one service only.
      await expect(
        checkout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId,
          serviceId: otherProfessional.serviceId,
          callbackBaseUrl: 'http://x/cb',
        }),
      ).rejects.toMatchObject({ response: { code: 'SLOT_UNAVAILABLE' } });

      const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM booking.bookings`);
      expect(count).toBe(0);
    });

    it('rolls the BOOKING back when order creation fails -- one transaction, both or neither', async () => {
      const { customer, professional } = await scenario();
      // A generic slot plus a service id that does not exist at all: the
      // booking claim succeeds, then the catalogue lookup fails.
      const genericSlot = await seedSlot(dataSource, professional.id, null, futureSlotTime(150));

      await expect(
        checkout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId: genericSlot,
          serviceId: uuidv7(),
          callbackBaseUrl: 'http://x/cb',
        }),
      ).rejects.toMatchObject({ response: { code: 'SERVICE_UNAVAILABLE_FOR_SALE' } });

      const [{ bookings_count }] = await dataSource.query(`SELECT COUNT(*)::int AS bookings_count FROM booking.bookings`);
      const [{ orders_count }] = await dataSource.query(`SELECT COUNT(*)::int AS orders_count FROM commerce.orders`);
      const [slot] = await dataSource.query(`SELECT status, held_by_booking_id FROM booking.availability_slots WHERE id = $1`, [genericSlot]);

      expect(bookings_count).toBe(0);
      expect(orders_count).toBe(0);
      // The slot claim rolled back with it -- not left stuck on `held`, which
      // would silently remove a bookable slot from the professional's day.
      // (This is precisely the assertion pg-mem cannot make: it does not roll
      // back at all.)
      expect(slot.status).toBe('open');
      expect(slot.held_by_booking_id).toBeNull();
    });
  });

  describe('authorization', () => {
    it('lets a customer read their own booking', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      await request(app.getHttpServer())
        .get(`/api/v1/bookings/${booking.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);
    });

    it('lets the professional read a booking made with them', async () => {
      const { customer, owner, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      await request(app.getHttpServer())
        .get(`/api/v1/bookings/${booking.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
    });

    it("gives a stranger the same 404 as a nonexistent booking, leaking nothing", async () => {
      const { customer, other, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      const forbidden = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${booking.id}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);

      const nonexistent = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${uuidv7()}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);

      // Byte-identical: a caller cannot use the response to enumerate which
      // booking ids are real.
      expect(forbidden.body).toEqual(nonexistent.body);
      assertNoLeak(forbidden.body, customer.id);
    });

    it('refuses a stranger cancelling somebody else\'s booking, and leaves it untouched', async () => {
      const { customer, other, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ reason: 'malicious' })
        .expect(404);

      // Not merely "the request failed" -- the data is verified unchanged.
      const unchanged = await bookings.findById(booking.id);
      expect(unchanged?.status).toBe('pending');
      expect(unchanged?.cancellationReason).toBeNull();
    });

    it('refuses a CUSTOMER marking their own booking completed -- that is the professional\'s call', async () => {
      const { customer, professional, slotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });
      await bookings.confirm(booking.id);

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);

      expect((await bookings.findById(booking.id))?.status).toBe('confirmed');
    });

    it('rejects an unauthenticated booking attempt', async () => {
      const { professional, slotId } = await scenario();
      await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId })
        .expect(401);
    });

    it("refuses a professional managing another professional's availability", async () => {
      const { owner } = await scenario();
      const otherOwner = await seedUser(app, dataSource, '+989126666666', ['professional']);
      await seedProfessional(dataSource, otherOwner.id, 'دیگری');

      // There is no path parameter to tamper with: /v1/me/availability derives
      // the professional from the session, so this creates a slot for the
      // CALLER, never for anyone else.
      const response = await request(app.getHttpServer())
        .post('/api/v1/me/availability/slots')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ startAt: futureSlotTime(500).toISOString(), endAt: futureSlotTime(501).toISOString() })
        .expect(201);

      const [row] = await dataSource.query(`SELECT professional_id FROM booking.availability_slots WHERE id = $1`, [
        response.body.data.id,
      ]);
      const [mine] = await dataSource.query(`SELECT id FROM provider.professionals WHERE owner_id = $1`, [owner.id]);
      expect(row.professional_id).toBe(mine.id);
    });

    it('gives a user with no professional profile the generic 404 on the availability surface', async () => {
      const { customer } = await scenario();
      await request(app.getHttpServer())
        .get('/api/v1/me/availability')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);
    });

    it('refuses to delete a slot backing a live booking', async () => {
      const { owner, customer, professional, slotId } = await scenario();
      await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      await request(app.getHttpServer())
        .delete(`/api/v1/me/availability/slots/${slotId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(409);

      const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.status).toBe('held');
    });
  });

  describe('public availability exposes only what a customer needs', () => {
    it('never leaks hold details or booking ids', async () => {
      const { customer, professional, slotId, altSlotId } = await scenario();
      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/availability`)
        .expect(200);

      // The held slot is gone from the list, and nothing about who holds it
      // appears anywhere in the payload.
      const ids = response.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(altSlotId);
      expect(ids).not.toContain(slotId);
      assertNoLeak(response.body, booking.id);
      assertNoLeak(response.body, customer.id);
      expect(JSON.stringify(response.body)).not.toContain('heldUntil');
    });

    it('is reachable without a session', async () => {
      const { professional } = await scenario();
      await request(app.getHttpServer()).get(`/api/v1/providers/${professional.id}/availability`).expect(200);
    });
  });

  describe('bulk availability generation', () => {
    it('is idempotent -- re-running the same pattern creates nothing new', async () => {
      const { owner, professional } = await scenario();
      const from = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      const pattern = { weekdays: [0, 1, 2, 3, 4, 5, 6], timeStart: '09:00', timeEnd: '12:00', slotMinutes: 60, dateFrom: from, dateTo: to };

      const first = await availability.bulkGenerate(professional.id, pattern);
      expect(first.created).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);

      const second = await availability.bulkGenerate(professional.id, pattern);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(first.created);
      void owner;
    });

    it('rejects an unbounded date range rather than generating unbounded rows', async () => {
      const { professional } = await scenario();
      await expect(
        availability.bulkGenerate(professional.id, {
          weekdays: [1],
          timeStart: '09:00',
          timeEnd: '17:00',
          slotMinutes: 30,
          dateFrom: '2026-09-01',
          dateTo: '2030-09-01',
        }),
      ).rejects.toMatchObject({ response: { code: 'INVALID_SLOT_RANGE' } });
    });
  });
});
