import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BookingService } from '@beauclick/booking';
import { OutboxRelay } from '@beauclick/events';

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

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * The API surface the professional operating screens consume.
 *
 * Two things are proven here, and they are different in kind:
 *
 *  1. **The three routes V3.1 Task 1 added actually work and are isolated.**
 *     `GET /v1/me/provider`, `PATCH /v1/providers/:id/services/:serviceId`,
 *     and `DELETE /v1/providers/:id/services/:serviceId`. The service-layer
 *     methods behind the last two have existed since Phase 3 with no HTTP
 *     route; what is new -- and therefore what needs adversarial coverage --
 *     is the boundary.
 *
 *  2. **The Definition of Done fan-out.** Completing a booking is a
 *     professional-only action that, until this task, no product surface could
 *     trigger. Five consumers are wired to `BookingCompleted` and none of them
 *     had ever fired from a real product path. The last block asserts the
 *     chain end to end at the API level; the browser trace in
 *     `V3.1_TASK1_IMPLEMENTATION.md` §Live QA is the same trace through the UI.
 */
describePg('professional operating surface (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let bookings: BookingService;

  async function drainUntilQuiet(maxPasses = 6): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      const { dispatched } = await relay.drain();
      if (dispatched === 0) return;
    }
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // -------------------------------------------------------------------
  // GET /v1/me/provider -- the bootstrap the whole /pro surface needs
  // -------------------------------------------------------------------

  describe('GET /v1/me/provider', () => {
    it('answers null -- not 404 -- for a signed-in user with no professional profile', async () => {
      const user = await seedUser(app, dataSource, '+989120000001');

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/provider')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // The distinction matters to the client: `null` is an ANSWER ("you have
      // not created one"), a 404 would be indistinguishable from a failure.
      // Rendering a create-profile form on the wrong one of those is exactly
      // the QA-06/QA-07 bug class.
      expect(res.body.data).toBeNull();
      expect(res.body.error).toBeNull();
    });

    it("returns the caller's own profile, resolved from the session and not from any parameter", async () => {
      const owner = await seedUser(app, dataSource, '+989120000002');
      const professional = await seedProfessional(dataSource, owner.id, 'سالن نمونه');

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/provider')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(professional.id);
      expect(res.body.data.displayName).toBe('سالن نمونه');
    });

    it("never returns another user's profile, even when one exists", async () => {
      const ownerA = await seedUser(app, dataSource, '+989120000003');
      const professionalA = await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const userB = await seedUser(app, dataSource, '+989120000004');

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/provider')
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      expect(res.body.data).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(professionalA.id);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/provider').expect(401);
    });
  });

  // -------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------

  describe('reference data', () => {
    it('serves launched cities and specialties without a session', async () => {
      const cityId = uuidv7();
      const specialtyId = uuidv7();
      await dataSource.query(`INSERT INTO provider.locations_cities (id, name, is_launched) VALUES ($1, 'تهران', true)`, [
        cityId,
      ]);
      await dataSource.query(`INSERT INTO provider.specialties (id, name) VALUES ($1, 'میکاپ')`, [specialtyId]);

      const cities = await request(app.getHttpServer()).get('/api/v1/cities').expect(200);
      const specialties = await request(app.getHttpServer()).get('/api/v1/specialties').expect(200);

      expect(cities.body.data).toEqual(expect.arrayContaining([{ id: cityId, name: 'تهران' }]));
      expect(specialties.body.data).toEqual(expect.arrayContaining([{ id: specialtyId, name: 'میکاپ' }]));
    });

    it('omits unlaunched cities -- a city nobody can be found in is not an option', async () => {
      const launched = uuidv7();
      const unlaunched = uuidv7();
      await dataSource.query(`INSERT INTO provider.locations_cities (id, name, is_launched) VALUES ($1, 'یزد', true)`, [
        launched,
      ]);
      await dataSource.query(`INSERT INTO provider.locations_cities (id, name, is_launched) VALUES ($1, 'قم', false)`, [
        unlaunched,
      ]);

      const res = await request(app.getHttpServer()).get('/api/v1/cities').expect(200);
      const ids = (res.body.data as { id: string }[]).map((c) => c.id);

      expect(ids).toContain(launched);
      expect(ids).not.toContain(unlaunched);
    });
  });

  // -------------------------------------------------------------------
  // Service catalogue edit/delete -- the new boundary
  // -------------------------------------------------------------------

  describe('service catalogue mutation', () => {
    it("edits the owner's own service", async () => {
      const owner = await seedUser(app, dataSource, '+989120000010');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/services/${professional.serviceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ priceToman: 450_000, name: 'کوتاهی مو' })
        .expect(200);

      expect(res.body.data.priceToman).toBe(450_000);
      expect(res.body.data.name).toBe('کوتاهی مو');
    });

    it('soft-deletes the service and removes it from the public catalogue', async () => {
      const owner = await seedUser(app, dataSource, '+989120000011');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');

      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professional.id}/services/${professional.serviceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/services`)
        .expect(200);
      expect(listed.body.data).toHaveLength(0);

      // Soft, not hard: the row survives so past order line items still
      // resolve and search has something to be told about.
      const rows = await dataSource.query(
        `SELECT deleted_at FROM provider.services WHERE id = $1`,
        [professional.serviceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it("refuses to edit ANOTHER professional's service, indistinguishably from a nonexistent one", async () => {
      const ownerA = await seedUser(app, dataSource, '+989120000012');
      const professionalA = await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const ownerB = await seedUser(app, dataSource, '+989120000013');
      const professionalB = await seedProfessional(dataSource, ownerB.id, 'متخصص ب');

      // B naming A's professional id: OwnershipGuard resolves the row's REAL
      // owner and refuses before the handler runs.
      const viaForeignProvider = await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professionalA.id}/services/${professionalA.serviceId}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ priceToman: 1 })
        .expect(404);
      expect(viaForeignProvider.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');

      // B naming their OWN professional id but A's service id: the guard
      // passes (B does own that provider), so the SECOND check -- the
      // professionalId in the service query's own WHERE clause -- is what
      // stops it. This is the case a controller-only check would miss.
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professionalB.id}/services/${professionalA.serviceId}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ priceToman: 1 })
        .expect(404);

      const unchanged = await dataSource.query(`SELECT price_toman FROM provider.services WHERE id = $1`, [
        professionalA.serviceId,
      ]);
      expect(Number(unchanged[0].price_toman)).toBe(professionalA.priceToman);
    });

    it("refuses to delete another professional's service, and leaves it intact", async () => {
      const ownerA = await seedUser(app, dataSource, '+989120000014');
      const professionalA = await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const ownerB = await seedUser(app, dataSource, '+989120000015');
      const professionalB = await seedProfessional(dataSource, ownerB.id, 'متخصص ب');

      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professionalB.id}/services/${professionalA.serviceId}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .expect(404);

      const rows = await dataSource.query(`SELECT deleted_at FROM provider.services WHERE id = $1`, [
        professionalA.serviceId,
      ]);
      expect(rows[0].deleted_at).toBeNull();
    });

    it('returns the generic refusal for an already-deleted service rather than reporting success twice', async () => {
      const owner = await seedUser(app, dataSource, '+989120000016');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');

      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professional.id}/services/${professional.serviceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      const second = await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professional.id}/services/${professional.serviceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);
      expect(second.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
    });

    it('rejects a customer with no professional profile at the ownership boundary', async () => {
      const owner = await seedUser(app, dataSource, '+989120000017');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      const customer = await seedUser(app, dataSource, '+989120000018');

      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/services/${professional.serviceId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ priceToman: 1 })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------
  // Availability: the routes the /pro screen actually calls
  // -------------------------------------------------------------------

  describe('own availability', () => {
    it('answers the generic refusal for a caller with no professional profile', async () => {
      const customer = await seedUser(app, dataSource, '+989120000020');

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/availability')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
    });

    it('lists only the caller’s own slots, with their status', async () => {
      const ownerA = await seedUser(app, dataSource, '+989120000021');
      const professionalA = await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const ownerB = await seedUser(app, dataSource, '+989120000022');
      const professionalB = await seedProfessional(dataSource, ownerB.id, 'متخصص ب');

      const slotA = await seedSlot(dataSource, professionalA.id, professionalA.serviceId, futureSlotTime(48));
      const slotB = await seedSlot(dataSource, professionalB.id, professionalB.serviceId, futureSlotTime(49));

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/availability')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);

      const ids = (res.body.data as { id: string; status: string }[]).map((s) => s.id);
      expect(ids).toContain(slotA);
      expect(ids).not.toContain(slotB);
      expect(res.body.data[0].status).toBe('open');
    });

    it('generates a weekly pattern in the PLATFORM timezone and is idempotent on re-run', async () => {
      const owner = await seedUser(app, dataSource, '+989120000023');
      await seedProfessional(dataSource, owner.id, 'متخصص');

      const from = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
      const body = {
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        timeStart: '09:00',
        timeEnd: '12:00',
        slotMinutes: 60,
        dateFrom: from,
        dateTo: to,
      };

      const first = await request(app.getHttpServer())
        .post('/api/v1/me/availability/bulk')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(body)
        .expect(201);
      expect(first.body.data.created).toBeGreaterThan(0);

      // Re-running the same pattern must create nothing new. The professional
      // screen offers this as a plain "generate" button with no warning, which
      // is only safe because the UNIQUE(professional_id, start_at) constraint
      // makes a repeat a no-op rather than a duplicate.
      const second = await request(app.getHttpServer())
        .post('/api/v1/me/availability/bulk')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(body)
        .expect(201);
      expect(second.body.data.created).toBe(0);
      expect(second.body.data.skipped).toBe(first.body.data.created);

      // The generated instants must read back as 09:00-12:00 IN TEHRAN, which
      // is the whole reason the frontend formats through a zone-explicit
      // helper rather than `Date#getHours()`.
      const rows = await dataSource.query(
        `SELECT to_char(start_at AT TIME ZONE 'Asia/Tehran', 'HH24:MI') AS local_start
           FROM booking.availability_slots ORDER BY start_at`,
      );
      expect(rows.map((r: { local_start: string }) => r.local_start)).toEqual(
        expect.arrayContaining(['09:00', '10:00', '11:00']),
      );
    });

    it('refuses to release a BOOKED slot -- the professional screen must not offer it, and the server does not allow it', async () => {
      const owner = await seedUser(app, dataSource, '+989120000024');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));
      await dataSource.query(`UPDATE booking.availability_slots SET status = 'booked' WHERE id = $1`, [slotId]);

      await request(app.getHttpServer())
        .delete(`/api/v1/me/availability/slots/${slotId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(409);

      const rows = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(rows[0].status).toBe('booked');
    });

    it("refuses to release another professional's open slot", async () => {
      const ownerA = await seedUser(app, dataSource, '+989120000025');
      const professionalA = await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const ownerB = await seedUser(app, dataSource, '+989120000026');
      await seedProfessional(dataSource, ownerB.id, 'متخصص ب');

      const slotA = await seedSlot(dataSource, professionalA.id, professionalA.serviceId, futureSlotTime(48));

      await request(app.getHttpServer())
        .delete(`/api/v1/me/availability/slots/${slotA}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .expect(409);

      const rows = await dataSource.query(`SELECT id FROM booking.availability_slots WHERE id = $1`, [slotA]);
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Booking lifecycle actions, from the professional's side
  // -------------------------------------------------------------------

  describe('booking actions', () => {
    /**
     * A monotonic suffix, replacing `Math.floor(Math.random() * 90) + 10`.
     *
     * The random form drew from a pool of **90** values per prefix, and every
     * case below seeds at least two professionals and two customers — so two
     * draws from one pool collided on `uq_users_phone` about **1 run in 45**.
     * It failed a required CI check exactly that way on 2026-09-01, in a run
     * whose changes were confined to the referral calendar and could not have
     * touched this file.
     *
     * Fixed rather than re-run, because re-running is how a flake gets retried
     * into the tree; and made deterministic rather than merely wider, because a
     * bigger random pool lowers the odds without removing them. Every other
     * fixture in this file already uses a fixed unique phone — this one was the
     * outlier.
     */
    let phoneSeq = 0;
    const nextPhone = (prefix: string) => `${prefix}${String((phoneSeq += 1)).padStart(2, '0')}`;

    async function seedConfirmedBooking(opts: { hoursFromNow: number }) {
      const proUser = await seedUser(app, dataSource, nextPhone('+9891200001'));
      const professional = await seedProfessional(dataSource, proUser.id, 'متخصص');
      const customer = await seedUser(app, dataSource, nextPhone('+9891200002'));
      const slotId = await seedSlot(
        dataSource,
        professional.id,
        professional.serviceId,
        futureSlotTime(opts.hoursFromNow),
      );

      const booking = await bookings.create({
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
        slotId,
        idempotencyKey: uuidv7(),
      });
      await dataSource.query(`UPDATE booking.bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [
        booking.id,
      ]);
      return { proUser, professional, customer, booking, slotId };
    }

    it('lists the professional’s own bookings and nobody else’s', async () => {
      const a = await seedConfirmedBooking({ hoursFromNow: 48 });
      const b = await seedConfirmedBooking({ hoursFromNow: 72 });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/professional-bookings')
        .set('Authorization', `Bearer ${a.proUser.accessToken}`)
        .expect(200);

      const ids = (res.body.data as { id: string }[]).map((x) => x.id);
      expect(ids).toContain(a.booking.id);
      expect(ids).not.toContain(b.booking.id);
    });

    it('refuses completion by the CUSTOMER -- completion is the professional’s statement, not the customer’s', async () => {
      const { customer, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);

      const rows = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [booking.id]);
      expect(rows[0].status).toBe('confirmed');
    });

    it('refuses completion by an unrelated professional', async () => {
      const { booking } = await seedConfirmedBooking({ hoursFromNow: 48 });
      const stranger = await seedUser(app, dataSource, '+989129999001');
      await seedProfessional(dataSource, stranger.id, 'بیگانه');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
    });

    it('refuses a no-show BEFORE the slot has ended, and the UI must not offer it either', async () => {
      const { proUser, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/no-show`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(409);
      expect(res.body.error.code).toBeDefined();

      const rows = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [booking.id]);
      expect(rows[0].status).toBe('confirmed');
    });

    it('accepts a no-show once the slot has ended', async () => {
      const { proUser, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '3 hours', slot_end = now() - interval '2 hours' WHERE id = $1`,
        [booking.id],
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/no-show`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(201);
      expect(res.body.data.status).toBe('no_show');
    });

    it('REFUSES completion of a booking the customer already cancelled, with a 409 and no state change', async () => {
      const { proUser, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });
      await dataSource.query(`UPDATE booking.bookings SET status = 'cancelled' WHERE id = $1`, [booking.id]);

      // A human-initiated transition uses `onIllegal: 'throw'` deliberately
      // (booking.service.ts:716 explains why: 'report' exists for the payment
      // path, where throwing would roll back a real charge). So the
      // professional gets a 409, not a silent no-op reported as success.
      //
      // This is the stale-data case the UI must handle: the card on screen
      // still said "تأیید شده" because the customer cancelled after the list
      // was fetched. The screen therefore RELOADS on a rejected action rather
      // than only showing the error, so the true state replaces the stale one.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(409);
      expect(res.body.error.code).toBeDefined();

      expect(await bookingStatus(booking.id)).toBe('cancelled');
    });

    it('exposes booking history to the professional party', async () => {
      const { proUser, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/bookings/${booking.id}/history`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('refuses booking history to an unrelated professional', async () => {
      const { booking } = await seedConfirmedBooking({ hoursFromNow: 48 });
      const stranger = await seedUser(app, dataSource, '+989129999002');
      await seedProfessional(dataSource, stranger.id, 'بیگانه');

      await request(app.getHttpServer())
        .get(`/api/v1/bookings/${booking.id}/history`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
    });

    it('reschedules onto another of the professional’s own open slots, releasing the original', async () => {
      const { proUser, professional, booking, slotId } = await seedConfirmedBooking({ hoursFromNow: 48 });
      const targetSlot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72));

      const res = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/reschedule`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .send({ newSlotId: targetSlot })
        .expect(201);

      expect(res.body.data.slotId).toBe(targetSlot);
      expect(res.body.data.rescheduleCount).toBe(1);

      const original = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(original[0].status).toBe('open');
    });

    it('refuses a reschedule onto ANOTHER professional’s slot', async () => {
      const { proUser, booking } = await seedConfirmedBooking({ hoursFromNow: 48 });
      const otherUser = await seedUser(app, dataSource, '+989129999003');
      const otherPro = await seedProfessional(dataSource, otherUser.id, 'دیگری');
      const foreignSlot = await seedSlot(dataSource, otherPro.id, otherPro.serviceId, futureSlotTime(96));

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/reschedule`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .send({ newSlotId: foreignSlot })
        .expect(409);

      const slot = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [foreignSlot]);
      expect(slot[0].status).toBe('open');
    });
  });

  // -------------------------------------------------------------------
  // The Definition of Done: completion fans out
  // -------------------------------------------------------------------

  describe('completing a booking fans out to every wired consumer', () => {
    it('awards loyalty points, writes a journey timeline entry, and moves the completed_bookings ranking signal', async () => {
      const proUser = await seedUser(app, dataSource, '+989127000001');
      const professional = await seedProfessional(dataSource, proUser.id, 'متخصص کامل');
      const customer = await seedUser(app, dataSource, '+989127000002');
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));

      const booking = await bookings.create({
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
        slotId,
        idempotencyKey: uuidv7(),
      });
      await dataSource.query(`UPDATE booking.bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [
        booking.id,
      ]);
      // Drain everything the CREATE produced, so the assertions below are
      // about completion and nothing else.
      await drainUntilQuiet();

      const pointsBefore = await countPoints(customer.id);
      const timelineBefore = await countTimeline(customer.id);
      const signalBefore = await completedSignal(professional.id);

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(201);

      await drainUntilQuiet();

      expect(await bookingStatus(booking.id)).toBe('completed');
      expect(await countPoints(customer.id)).toBeGreaterThan(pointsBefore);
      expect(await countTimeline(customer.id)).toBeGreaterThan(timelineBefore);
      expect(await completedSignal(professional.id)).toBe(signalBefore + 1);
    });

    it('is idempotent under redelivery -- a replayed BookingCompleted double-counts nothing', async () => {
      const proUser = await seedUser(app, dataSource, '+989127000003');
      const professional = await seedProfessional(dataSource, proUser.id, 'متخصص تکرار');
      const customer = await seedUser(app, dataSource, '+989127000004');
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));

      const booking = await bookings.create({
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
        slotId,
        idempotencyKey: uuidv7(),
      });
      await dataSource.query(`UPDATE booking.bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [
        booking.id,
      ]);
      await drainUntilQuiet();

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${booking.id}/complete`)
        .set('Authorization', `Bearer ${proUser.accessToken}`)
        .expect(201);
      await drainUntilQuiet();

      const points = await countPoints(customer.id);
      const signal = await completedSignal(professional.id);

      // Re-publish the completion event by hand, exactly as an at-least-once
      // transport would. The consumers' own idempotency keys
      // (`UNIQUE(reference_type, reference_id, reason)` for loyalty,
      // `search.signal_applications` for ranking) are what must hold.
      await dataSource.query(
        `UPDATE booking.outbox_events SET published_at = NULL WHERE event_type = 'BookingCompleted' AND aggregate_id = $1`,
        [booking.id],
      );
      await drainUntilQuiet();

      expect(await countPoints(customer.id)).toBe(points);
      expect(await completedSignal(professional.id)).toBe(signal);
    });
  });

  // ------------------------------------------------------------ helpers

  async function bookingStatus(bookingId: string): Promise<string> {
    const rows = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [bookingId]);
    return rows[0]?.status;
  }

  async function countPoints(userId: string): Promise<number> {
    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM loyalty.points_entries WHERE user_id = $1 AND reason = 'booking_completed'`,
      [userId],
    );
    return rows[0].n;
  }

  async function countTimeline(userId: string): Promise<number> {
    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM journey.timeline_entries WHERE user_id = $1`,
      [userId],
    );
    return rows[0].n;
  }

  async function completedSignal(professionalId: string): Promise<number> {
    const rows = await dataSource.query(
      `SELECT completed_bookings FROM search.ranking_signals WHERE professional_id = $1`,
      [professionalId],
    );
    return rows[0] ? Number(rows[0].completed_bookings) : 0;
  }
});
