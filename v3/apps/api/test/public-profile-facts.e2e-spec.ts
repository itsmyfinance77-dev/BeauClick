import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { createTestApp, CapturingOtpObserver } from './test-app.factory';
import { PUBLIC_COMPLETED_BOOKING_COUNT_SQL } from '@beauclick/booking';

/**
 * #226 -- the public completed-booking count on `GET /v1/providers/:id`.
 *
 * The count is a number about a seller that every visitor reads. What is pinned
 * here is the DEFINITION, not merely that a number appears: lifetime; only
 * `completed`; only once the appointment has ended by the database clock; only
 * this professional's; and nothing but the integer leaves.
 *
 * Runs on the pg-mem layer with the REAL adapter (`BookingBackedCompletedBookingCount`)
 * over a real `booking.bookings` table. The real-PostgreSQL suite repeats the
 * time-sensitive cases against the server's own clock and drives a booking
 * through the real lifecycle.
 */
describe('Public completed-booking count (e2e)', () => {
  let app: INestApplication;
  let otpObserver: CapturingOtpObserver;
  let dataSource: DataSource;
  let phoneSeq = 0;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    otpObserver = testApp.otpObserver;
    dataSource = testApp.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  const HOUR = 3_600_000;

  async function loginAsNewUser(): Promise<{ accessToken: string; userId: string }> {
    const phone = `0914${String(1000000 + ++phoneSeq)}`;
    await request(app.getHttpServer()).post('/api/v1/auth/request-otp').send({ phone, purpose: 'login' });
    const code = otpObserver.lastCodeFor('+98' + phone.slice(1));
    const verify = await request(app.getHttpServer()).post('/api/v1/auth/verify-otp').send({ phone, code, purpose: 'login' });
    return { accessToken: verify.body.data.accessToken, userId: verify.body.data.user.id };
  }

  async function createProfessional(displayName: string): Promise<{ id: string; accessToken: string }> {
    const { accessToken } = await loginAsNewUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ displayName, bio: 'bio' });
    expect(res.status).toBeLessThan(300);
    return { id: res.body.data.id, accessToken };
  }

  /** A booking row exactly as the lifecycle would leave it, with the end instant chosen by the test. */
  async function seedBooking(input: {
    professionalId: string;
    status: string;
    endsInMs: number;
    customerId?: string;
  }): Promise<{ id: string; customerId: string }> {
    const id = uuidv7();
    const customerId = input.customerId ?? uuidv7();
    const end = new Date(Date.now() + input.endsInMs);
    const start = new Date(end.getTime() - HOUR);
    await dataSource.query(
      `INSERT INTO booking.bookings
         (id, customer_id, professional_id, slot_id, slot_start, slot_end, status, reschedule_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, now(), now())`,
      [id, customerId, input.professionalId, uuidv7(), start, end, input.status],
    );
    return { id, customerId };
  }

  async function countOf(professionalId: string): Promise<unknown> {
    const res = await request(app.getHttpServer()).get(`/api/v1/providers/${professionalId}`).expect(200);
    return res.body.data.completedBookingCount;
  }

  it('is zero, as a real integer, for a professional with no bookings at all', async () => {
    const pro = await createProfessional('بدون نوبت');
    expect(await countOf(pro.id)).toBe(0);
  });

  it('counts a completed booking whose appointment has ended, and several of them', async () => {
    const pro = await createProfessional('چند نوبت');
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -2 * HOUR });
    expect(await countOf(pro.id)).toBe(1);
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -30 * 24 * HOUR });
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -1000 });
    expect(await countOf(pro.id)).toBe(3);
  });

  it('does not count a booking marked completed while its appointment is still ahead', async () => {
    // `BookingService.complete` has no "the appointment has ended" precondition:
    // a professional can close a confirmed booking out early. Counting that
    // would let a seller pad their own profile with tomorrow's appointments.
    const pro = await createProfessional('زودهنگام');
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -HOUR });
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: 5 * 60_000 });
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: 3 * 24 * HOUR });
    expect(await countOf(pro.id)).toBe(1);
  });

  it.each(['pending', 'confirmed', 'cancelled', 'expired', 'no_show'])(
    'does not count a %s booking, even one whose appointment is long over',
    async (status) => {
      const pro = await createProfessional(`وضعیت ${status}`);
      await seedBooking({ professionalId: pro.id, status, endsInMs: -10 * 24 * HOUR });
      expect(await countOf(pro.id)).toBe(0);
    },
  );

  it("does not count another professional's completed bookings", async () => {
    const a = await createProfessional('متخصص الف');
    const b = await createProfessional('متخصص ب');
    await seedBooking({ professionalId: b.id, status: 'completed', endsInMs: -2 * HOUR });
    await seedBooking({ professionalId: b.id, status: 'completed', endsInMs: -3 * HOUR });
    await seedBooking({ professionalId: a.id, status: 'completed', endsInMs: -HOUR });

    expect(await countOf(a.id)).toBe(1);
    expect(await countOf(b.id)).toBe(2);
  });

  it('counts appointments performed, not distinct customers', async () => {
    const pro = await createProfessional('یک مشتری');
    const customerId = uuidv7();
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -2 * HOUR, customerId });
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -4 * HOUR, customerId });
    expect(await countOf(pro.id)).toBe(2);
  });

  it('is unmoved by anything the request carries', async () => {
    const pro = await createProfessional('بی‌اثر');
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -HOUR });

    for (const query of [
      '?completedBookingCount=999',
      '?count=999&status=confirmed',
      '?from=2000-01-01&to=2100-01-01',
      `?professionalId=${uuidv7()}`,
    ]) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/providers/${pro.id}${query}`)
        .set('X-Completed-Bookings', '999')
        .expect(200);
      expect(res.body.data.completedBookingCount).toBe(1);
    }
  });

  it("is unmoved by the professional's own profile fields", async () => {
    const pro = await createProfessional('تلاش برای دستکاری');
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -HOUR });

    // The count is not a column the owner can write: an attempt to send it is a
    // validation failure, not a silent no-op that a later refactor could honour.
    const attempt = await request(app.getHttpServer())
      .patch(`/api/v1/providers/${pro.id}`)
      .set('Authorization', `Bearer ${pro.accessToken}`)
      .send({ bio: 'x', completedBookingCount: 500 });
    expect(attempt.status).toBe(400);
    expect(await countOf(pro.id)).toBe(1);
  });

  it('publishes an integer and nothing about who booked, when, or how it was paid', async () => {
    const pro = await createProfessional('بدون افشا');
    const seeded = [
      await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -2 * HOUR }),
      await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -5 * HOUR }),
    ];

    const res = await request(app.getHttpServer()).get(`/api/v1/providers/${pro.id}`).expect(200);
    expect(Number.isInteger(res.body.data.completedBookingCount)).toBe(true);
    expect(res.body.data.completedBookingCount).toBeGreaterThanOrEqual(0);

    const wire = JSON.stringify(res.body);
    for (const booking of seeded) {
      expect(wire).not.toContain(booking.id);
      expect(wire).not.toContain(booking.customerId);
    }
    // No collection of bookings, and no field that could carry one.
    expect(Object.keys(res.body.data).filter((key) => /booking|customer|slot|order/i.test(key))).toEqual([
      'completedBookingCount',
    ]);
  });

  it("is on the detail read only: the listing and the owner's own profile do not carry a default", async () => {
    const pro = await createProfessional('فقط جزئیات');
    await seedBooking({ professionalId: pro.id, status: 'completed', endsInMs: -HOUR });

    const list = await request(app.getHttpServer()).get('/api/v1/providers').expect(200);
    const listed = list.body.data.find((p: { id: string }) => p.id === pro.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('completedBookingCount');

    const mine = await request(app.getHttpServer())
      .get('/api/v1/me/provider')
      .set('Authorization', `Bearer ${pro.accessToken}`)
      .expect(200);
    expect(mine.body.data).not.toHaveProperty('completedBookingCount');
  });

  it('still refuses an unknown professional with the same envelope, and says nothing about a count', async () => {
    const unknown = await request(app.getHttpServer()).get(`/api/v1/providers/${uuidv7()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
    expect(unknown.body.data).toBeNull();
    expect(JSON.stringify(unknown.body)).not.toMatch(/completedBookingCount/);
  });

  it('is defined by one statement that names all three conditions', () => {
    // The pg-mem layer and the real server run the SAME text. A change to any
    // of the three conditions is a change to this string, and lands here.
    const sql = PUBLIC_COMPLETED_BOOKING_COUNT_SQL.replace(/\s+/g, ' ').trim();
    expect(sql).toContain('professional_id = $1');
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain('slot_end <= now()');
  });
});
