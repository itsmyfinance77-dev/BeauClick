import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { BookingService, SlotTooShortForServiceException } from '@beauclick/booking';
import { WaitlistService } from '@beauclick/waitlist';
import { OutboxRelay } from '@beauclick/events';

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
 * REAL PostgreSQL: demo remediation F-5 -- a slot must cover its service.
 *
 * Before the fix a booking claimed exactly one slot whatever the service's
 * duration: a 120-minute service booked into a 60-minute slot left the
 * professional's next slot open, so a second customer could book time the
 * professional was still spending on the first (a real double booking), and a
 * required resource was reserved for only the first hour.
 *
 * The rule enforced is the conservative one (no contract exists for spanning
 * several slots): a slot is LISTED for a service, and CLAIMABLE for it, only
 * when it is at least as long as the service -- the same rule on the listing,
 * on creation (and therefore checkout) and on reschedule.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Service duration vs slot length (demo F-5)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let checkout: CheckoutService;

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    checkout = app.get(CheckoutService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  /** A professional with a 60-min service (the fixture's) and a 120-min one; 60-min slots at +48h and +49h, a 120-min slot at +52h. */
  async function scenario() {
    const owner = await seedUser(app, dataSource, uniquePhone('+98912'), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
    const longServiceId = uuidv7();
    await dataSource.query(
      `INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman) VALUES ($1, $2, 'رنگ مو', 120, 300000)`,
      [longServiceId, professional.id],
    );
    const customer = await seedUser(app, dataSource, uniquePhone('+98935'), ['customer']);
    const short1 = await seedSlot(dataSource, professional.id, null, futureSlotTime(48), 60);
    const short2 = await seedSlot(dataSource, professional.id, null, futureSlotTime(49), 60);
    const long = await seedSlot(dataSource, professional.id, null, futureSlotTime(52), 120);
    return { owner, professional, longServiceId, customer, short1, short2, long };
  }

  async function slotRow(id: string) {
    const [row] = await dataSource.query(`SELECT status, held_by_booking_id FROM booking.availability_slots WHERE id = $1`, [id]);
    return row as { status: string; held_by_booking_id: string | null };
  }

  const count = async (sql: string, params: unknown[] = []) => {
    const [{ n }] = await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
    return n as number;
  };

  describe('listing', () => {
    it('offers a 120-min service only the slot that covers it; a 60-min service and an unfiltered listing see every slot', async () => {
      const s = await scenario();
      const list = async (serviceId?: string) => {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/providers/${s.professional.id}/availability${serviceId ? `?serviceId=${serviceId}` : ''}`)
          .expect(200);
        return (res.body.data as { id: string }[]).map((x) => x.id).sort();
      };

      expect(await list(s.longServiceId)).toEqual([s.long]);
      expect(await list(s.professional.serviceId)).toEqual([s.short1, s.short2, s.long].sort());
      expect(await list()).toEqual([s.short1, s.short2, s.long].sort());
    });
  });

  describe('creation', () => {
    it('refuses a 120-min service in a 60-min slot, leaving the slot open and nothing written', async () => {
      const s = await scenario();
      await expect(
        bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.short1, serviceId: s.longServiceId }),
      ).rejects.toBeInstanceOf(SlotTooShortForServiceException);

      expect(await slotRow(s.short1)).toEqual({ status: 'open', held_by_booking_id: null });
      expect(await count('booking.bookings')).toBe(0);
    });

    it('accepts the same service in a slot that covers it (control)', async () => {
      const s = await scenario();
      const booking = await bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.long, serviceId: s.longServiceId });
      expect(booking.status).toBe('pending');
      expect((await slotRow(s.long)).status).toBe('held');
    });

    it('a 60-min service still books a 60-min slot (the fixture case is unchanged)', async () => {
      const s = await scenario();
      const booking = await bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.short1, serviceId: s.professional.serviceId });
      expect(booking.slotId).toBe(s.short1);
    });

    it('a service-bound slot too short for its own service is refused too', async () => {
      const s = await scenario();
      const bound = await seedSlot(dataSource, s.professional.id, s.longServiceId, futureSlotTime(60), 60);
      await expect(
        bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: bound }),
      ).rejects.toBeInstanceOf(SlotTooShortForServiceException);
      expect((await slotRow(bound)).status).toBe('open');
    });

    it('HTTP checkout answers 409 SLOT_TOO_SHORT_FOR_SERVICE and creates no booking, order or payment intent', async () => {
      const s = await scenario();
      const res = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .set('Idempotency-Key', uuidv7())
        .send({ professionalId: s.professional.id, slotId: s.short1, serviceId: s.longServiceId })
        .expect(409);
      expect(res.body.error.code).toBe('SLOT_TOO_SHORT_FOR_SERVICE');
      expect(await count('booking.bookings')).toBe(0);
      expect(await count('commerce.orders')).toBe(0);
      expect(await count('payment.payment_intents')).toBe(0);
      expect((await slotRow(s.short1)).status).toBe('open');
    });

    it('checkout of the covering slot still produces booking + order (control)', async () => {
      const s = await scenario();
      const result = await checkout.checkout({
        customerId: s.customer.id,
        professionalId: s.professional.id,
        slotId: s.long,
        serviceId: s.longServiceId,
        callbackBaseUrl: 'http://x/cb',
      });
      expect(result.order.order.totalToman).toBe(300000);
    });
  });

  describe('reschedule', () => {
    it('refuses moving a 120-min booking into a 60-min slot; booking, old and new slot unchanged', async () => {
      const s = await scenario();
      const booking = await bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.long, serviceId: s.longServiceId });

      await expect(
        bookings.reschedule(booking.id, s.short2, { type: 'professional', id: s.owner.id }),
      ).rejects.toBeInstanceOf(SlotTooShortForServiceException);

      const [after] = await dataSource.query(`SELECT slot_id, status FROM booking.bookings WHERE id = $1`, [booking.id]);
      expect(after).toEqual({ slot_id: s.long, status: 'pending' });
      expect((await slotRow(s.long)).held_by_booking_id).toBe(booking.id);
      expect(await slotRow(s.short2)).toEqual({ status: 'open', held_by_booking_id: null });
    });

    it('allows moving it into another covering slot (control)', async () => {
      const s = await scenario();
      const booking = await bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.long, serviceId: s.longServiceId });
      const long2 = await seedSlot(dataSource, s.professional.id, null, futureSlotTime(70), 180);
      const moved = await bookings.reschedule(booking.id, long2, { type: 'professional', id: s.owner.id });
      expect(moved.slotId).toBe(long2);
    });
  });

  describe('waitlist matcher', () => {
    it('a reopened 60-min slot skips the waiter for the 120-min service and offers the next fitting waiter', async () => {
      const s = await scenario();
      const waitlist = app.get(WaitlistService);
      const relay = app.get(OutboxRelay);
      const longWaiter = await waitlist.join({ customerId: s.customer.id, professionalId: s.professional.id, serviceId: s.longServiceId });
      await new Promise((r) => setTimeout(r, 5));
      const other = await seedUser(app, dataSource, uniquePhone('+98937'), ['customer']);
      const fitWaiter = await waitlist.join({ customerId: other.id, professionalId: s.professional.id, serviceId: s.professional.serviceId });

      const holder = await seedUser(app, dataSource, uniquePhone('+98938'), ['customer']);
      const held = await bookings.create({ customerId: holder.id, professionalId: s.professional.id, slotId: s.short1, serviceId: s.professional.serviceId });
      await bookings.cancel(held.id, { type: 'customer', id: holder.id }, null);
      await relay.drain();

      expect((await waitlist.findById(longWaiter.id))?.status).toBe('waiting');
      const offered = await waitlist.findById(fitWaiter.id);
      expect(offered?.status).toBe('offered');
      expect(offered?.offeredSlotId).toBe(s.short1);
    });

    it('a reopened slot long enough is offered to the 120-min waiter first (FIFO kept)', async () => {
      const s = await scenario();
      const waitlist = app.get(WaitlistService);
      const relay = app.get(OutboxRelay);
      const longWaiter = await waitlist.join({ customerId: s.customer.id, professionalId: s.professional.id, serviceId: s.longServiceId });
      const holder = await seedUser(app, dataSource, uniquePhone('+98939'), ['customer']);
      const held = await bookings.create({ customerId: holder.id, professionalId: s.professional.id, slotId: s.long, serviceId: s.professional.serviceId });
      await bookings.cancel(held.id, { type: 'customer', id: holder.id }, null);
      await relay.drain();

      const offered = await waitlist.findById(longWaiter.id);
      expect(offered?.status).toBe('offered');
      expect(offered?.offeredSlotId).toBe(s.long);
    });
  });

  describe('the defect itself', () => {
    it('the professional can no longer be double-booked by the 120-min-in-60-min shape', async () => {
      const s = await scenario();
      // Pre-fix: customer A books the 120-min service at +48h (a 60-min slot) and
      // customer B books +49h -- both succeeded, overlapping by 60 minutes.
      await expect(
        bookings.create({ customerId: s.customer.id, professionalId: s.professional.id, slotId: s.short1, serviceId: s.longServiceId }),
      ).rejects.toBeInstanceOf(SlotTooShortForServiceException);
      const other = await seedUser(app, dataSource, uniquePhone('+98936'), ['customer']);
      await bookings.create({ customerId: other.id, professionalId: s.professional.id, slotId: s.short2, serviceId: s.professional.serviceId });

      const overlaps = await dataSource.query(
        `SELECT a.id FROM booking.bookings a JOIN provider.services sa ON sa.id = a.service_id
           JOIN booking.bookings b ON b.professional_id = a.professional_id AND b.id <> a.id
          WHERE a.status IN ('pending','confirmed') AND b.status IN ('pending','confirmed')
            AND b.slot_start < a.slot_start + make_interval(mins => sa.duration_minutes) AND b.slot_end > a.slot_start`,
      );
      expect(overlaps).toEqual([]);
    });
  });
});
