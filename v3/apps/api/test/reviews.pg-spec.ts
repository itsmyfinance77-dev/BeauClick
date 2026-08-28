import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RoleService } from '@beauclick/identity';
import { BookingService } from '@beauclick/booking';
import { OutboxRelay } from '@beauclick/events';
import { SearchIndexerService } from '@beauclick/search';

import {
  PgTestApp,
  SeededProfessional,
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
 * V3.1 Phase D — reviews and the rating signal, against real PostgreSQL.
 *
 * Two things are under test, and the second is the one the phase actually
 * exists for.
 *
 * **Eligibility is a database invariant, not a service check.** The write path
 * refuses a review for a booking that never completed, a second review for one
 * booking, and a review of somebody else's booking — and it refuses them
 * through a FOREIGN KEY and a UNIQUE index, so the refusal holds under
 * concurrency and cannot be forgotten by a future caller. The concurrency case
 * is tested directly, because that is the only way to tell a constraint from a
 * read-then-write that usually works.
 *
 * **QA-18: the rating signal has a writer.** `search.ranking_signals.rating_sum`
 * and `.review_count` have existed since Phase 3 with a migration comment
 * saying nothing writes them. Everything built on top — the Bayesian shrinkage
 * term, the `high_rating` badge, the `minRating` filter, the `rating` sort —
 * has been inert at 0/0 ever since. The cases below prove each of those moves,
 * including the one that would be easy to ship broken: a hidden review must
 * take its contribution back out, or moderation is decorative for ranking.
 */
describePg('V3.1 Phase D — reviews and the rating signal (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let roles: RoleService;
  let indexer: SearchIndexerService;
  let bookings: BookingService;
  /** Keeps every seeded slot at a distinct hour, so two never trip the overlap exclusion constraint. */
  let slotHour = 0;

  async function drainUntilQuiet(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      const { dispatched } = await relay.drain();
      if (dispatched === 0) return;
    }
  }

  async function bootstrapRole(userId: string, roleSlug: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
       VALUES ($1, $2, NULL, 'test bootstrap') ON CONFLICT DO NOTHING`,
      [userId, roleSlug],
    );
  }

  async function tokenFor(userId: string): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const access = await roles.resolveAccess(userId);
    return jwt.sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  /**
   * A customer with a genuinely completed booking against `professional`,
   * ready to review.
   *
   * The booking is created through `BookingService` and completed through the
   * REAL `POST /v1/bookings/:id/complete` route, so `BookingCompleted` is
   * emitted by its real producer and the eligibility row is written by the
   * real consumer.
   *
   * An earlier version of this helper inserted the outbox row by hand. That
   * was faster and it was wrong for this suite specifically: eligibility is the
   * thing under test, and hand-writing the event would have proved the review
   * path works when given a well-formed event while proving nothing about
   * whether one is ever produced. It also skipped `emitContractEvent`'s
   * validation, so a payload the real producer could never emit would have
   * passed.
   */
  async function completeBookingFor(
    professional: SeededProfessional,
    proToken: string,
    customerPhone: string,
  ): Promise<{ customer: Awaited<ReturnType<typeof seedUser>>; bookingId: string }> {
    const customer = await seedUser(app, dataSource, customerPhone, ['customer']);

    slotHour += 3;
    const slotId = await seedSlot(
      dataSource,
      professional.id,
      professional.serviceId,
      futureSlotTime(24 + slotHour),
    );

    const booking = await bookings.create({
      customerId: customer.id,
      professionalId: professional.id,
      serviceId: professional.serviceId,
      slotId,
      idempotencyKey: uuidv7(),
    });

    // A hold becomes a confirmation on payment; this suite is about what
    // happens AFTER delivery, so the paid leg is set directly rather than
    // driven through checkout, exactly as `professional-surface.pg-spec` does.
    await dataSource.query(`UPDATE booking.bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [
      booking.id,
    ]);

    await request(app.getHttpServer())
      .post(`/api/v1/bookings/${booking.id}/complete`)
      .set('Authorization', `Bearer ${proToken}`)
      .expect(201);

    await drainUntilQuiet();
    return { customer, bookingId: booking.id };
  }

  /** A professional plus their owning session, seeded together. */
  async function seedPro(phone: string, displayName: string) {
    const proUser = await seedUser(app, dataSource, phone, ['professional']);
    const professional = await seedProfessional(dataSource, proUser.id, displayName);
    return { proUser, professional };
  }

  async function signalsFor(professionalId: string): Promise<{ rating_sum: number; review_count: number } | undefined> {
    const [row] = await dataSource.query(
      'SELECT rating_sum, review_count FROM search.ranking_signals WHERE professional_id = $1',
      [professionalId],
    );
    return row ? { rating_sum: Number(row.rating_sum), review_count: Number(row.review_count) } : undefined;
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    roles = app.get(RoleService);
    indexer = app.get(SearchIndexerService);
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    slotHour = 0;
  });

  // ---------------------------------------------------------- eligibility

  describe('eligibility', () => {
    it('records eligibility from a real BookingCompleted, and a redelivery writes nothing new', async () => {
      const { proUser, professional } = await seedPro('+989130000101', 'سالن الف');
      const { customer, bookingId } = await completeBookingFor(professional, proUser.accessToken, '+989130000102');

      const rows = await dataSource.query('SELECT * FROM provider.review_eligibility WHERE booking_id = $1', [
        bookingId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].customer_id).toBe(customer.id);
      expect(rows[0].professional_id).toBe(professional.id);

      // The same event again, exactly as a relay restart mid-dispatch would
      // deliver it. `booking_id` is the PRIMARY KEY, so this is a no-op rather
      // than a duplicate or an error.
      await dataSource.query(
        "UPDATE booking.outbox_events SET published_at = NULL WHERE event_type = 'BookingCompleted'",
      );
      await drainUntilQuiet();

      const [{ count }] = await dataSource.query('SELECT count(*)::int FROM provider.review_eligibility');
      expect(count).toBe(1);
    });

    it('refuses a review for a booking that never completed', async () => {
      const customer = await seedUser(app, dataSource, '+989130000103', ['customer']);

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${uuidv7()}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5, comment: 'عالی بود' })
        .expect(409);
    });

    it("refuses a review of somebody else's booking, indistinguishably from one that does not exist", async () => {
      const { proUser: pro, professional } = await seedPro('+989130000104', 'سالن ب');
      const { bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000105');
      const stranger = await seedUser(app, dataSource, '+989130000106', ['customer']);

      const real = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ rating: 1 });
      const fabricated = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${uuidv7()}/review`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ rating: 1 });

      expect(real.status).toBe(409);
      // Byte-identical, so the endpoint cannot be used to discover which
      // booking ids exist or which of them completed.
      expect(real.body.error).toEqual(fabricated.body.error);
    });

    it('refuses an unauthenticated review', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${uuidv7()}/review`)
        .send({ rating: 5 })
        .expect(401);
    });

    it('refuses a rating outside 1-5', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000107', 'سالن پ');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000108');

      for (const rating of [0, 6, -1]) {
        await request(app.getHttpServer())
          .post(`/api/v1/bookings/${bookingId}/review`)
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ rating })
          .expect(400);
      }
    });

    it('refuses a second review for the same booking', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000109', 'سالن ت');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000110');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 1 })
        .expect(409);
    });

    it('produces exactly one review when two submissions race for the same booking', async () => {
      // The case that distinguishes a UNIQUE index from a read-then-write. Both
      // requests read no existing review; only the constraint stops the second
      // insert, and it has to translate into a clean 409 rather than a 500.
      const { proUser: pro, professional } = await seedPro('+989130000111', 'سالن ث');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000112');

      const results = await Promise.all(
        [5, 1].map((rating) =>
          request(app.getHttpServer())
            .post(`/api/v1/bookings/${bookingId}/review`)
            .set('Authorization', `Bearer ${customer.accessToken}`)
            .send({ rating }),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      const [{ count }] = await dataSource.query('SELECT count(*)::int FROM provider.reviews');
      expect(count).toBe(1);
    });

    it('cannot be bypassed at the database level either', async () => {
      // The invariant is a FOREIGN KEY, so it holds against anything with a
      // connection -- not only against callers who came through the service.
      const { proUser: pro, professional } = await seedPro('+989130000113', 'سالن ج');

      await expect(
        dataSource.query(
          `INSERT INTO provider.reviews (id, booking_id, professional_id, customer_id, rating)
           VALUES ($1, $2, $3, $4, 5)`,
          [uuidv7(), uuidv7(), professional.id, pro.id],
        ),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------- the rating signal

  describe('the rating signal (QA-18)', () => {
    it('moves ranking_signals, and the profile average agrees with it', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000120', 'سالن چ');

      for (const [i, rating] of [5, 4].entries()) {
        const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, `+98913000013${i}`);
        await request(app.getHttpServer())
          .post(`/api/v1/bookings/${bookingId}/review`)
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ rating })
          .expect(201);
      }
      await drainUntilQuiet();

      // The Definition-of-Done assertion, stated literally: review_count > 0
      // for a real provider, for the first time in the project's history.
      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 9, review_count: 2 });

      // And the profile's own average, computed from the reviews rather than
      // read back from the signal row, agrees.
      const profile = await request(app.getHttpServer()).get(`/api/v1/providers/${professional.id}`).expect(200);
      expect(profile.body.data.rating).toEqual({ average: 4.5, count: 2 });
    });

    it('is idempotent under event redelivery', async () => {
      // A counter increment is the one projection operation that is not
      // naturally idempotent: applying it twice leaves a permanently wrong
      // average with nothing afterwards able to detect it.
      const { proUser: pro, professional } = await seedPro('+989130000140', 'سالن ح');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000141');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);
      await drainUntilQuiet();

      // Re-publish the outbox row, exactly as a relay restart mid-dispatch
      // would, and drain again.
      await dataSource.query(
        "UPDATE provider.outbox_events SET published_at = NULL WHERE event_type = 'ReviewCreated'",
      );
      await drainUntilQuiet();

      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 5, review_count: 1 });
    });

    it('takes the contribution back out when a review is hidden, and restores it', async () => {
      // Without this, moderation is decorative for ranking: a review hidden for
      // abuse would keep influencing the provider's position forever.
      const { proUser: pro, professional } = await seedPro('+989130000150', 'سالن خ');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000151');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);
      await drainUntilQuiet();
      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 5, review_count: 1 });

      const moderator = await seedUser(app, dataSource, '+989130000152', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ decision: 'hide', reason: 'محتوای توهین‌آمیز' })
        .expect(201);
      await drainUntilQuiet();

      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 0, review_count: 0 });

      // And the profile stops showing it.
      const hidden = await request(app.getHttpServer()).get(`/api/v1/providers/${professional.id}`).expect(200);
      expect(hidden.body.data.rating).toEqual({ average: null, count: 0 });

      // Restoring puts it back. A moderator's mistake has to be reversible.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ decision: 'publish', reason: 'بررسی مجدد؛ مشکلی ندارد' })
        .expect(201);
      await drainUntilQuiet();

      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 5, review_count: 1 });
    });

    it('does not double-compensate when a moderation event is redelivered', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000160', 'سالن د');

      for (const [i, rating] of [5, 5].entries()) {
        const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, `+98913000016${i + 1}`);
        const created = await request(app.getHttpServer())
          .post(`/api/v1/bookings/${bookingId}/review`)
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ rating })
          .expect(201);
        if (i === 0) {
          await drainUntilQuiet();
          const moderator = await seedUser(app, dataSource, '+989130000169', ['customer']);
          await bootstrapRole(moderator.id, 'moderator');
          await request(app.getHttpServer())
            .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
            .set('Authorization', `Bearer ${await tokenFor(moderator.id)}`)
            .send({ decision: 'hide', reason: 'نامرتبط' })
            .expect(201);
        }
      }
      await drainUntilQuiet();
      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 5, review_count: 1 });

      await dataSource.query("UPDATE provider.outbox_events SET published_at = NULL WHERE event_type = 'ReviewModerated'");
      await drainUntilQuiet();

      // Unchanged. The compensating signal is guarded by its own row in
      // `signal_applications`, under a name distinct from the creation signal.
      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 5, review_count: 1 });
    });

    it('never drives the counters negative, even on an unmatched compensation', async () => {
      // Reachable in production after a projection rebuild resets the counters
      // and a moderation event then arrives for a review whose creation signal
      // is gone. The CHECK constraint forbids a negative, so without a clamp the
      // handler would throw, the outbox row would never publish, and the relay
      // would retry it forever -- wedging every event behind it.
      const { professional } = await seedPro('+989130000170', 'سالن ذ');

      const applied = await indexer.applyRatingSignal({
        eventId: uuidv7(),
        signalName: 'review_hidden',
        professionalId: professional.id,
        ratingDelta: -5,
        countDelta: -1,
      });

      expect(applied).toBe(true);
      expect(await signalsFor(professional.id)).toEqual({ rating_sum: 0, review_count: 0 });
    });

    it('awards the high_rating badge — for the first time in the project’s history', async () => {
      // Five reviews at 4.5+ is the documented bar. Below it the badge must not
      // appear, so both sides are asserted rather than only the positive.
      const { proUser: pro, professional } = await seedPro('+989130000180', 'سالن ر');

      await indexer.applyProfessional({
        professionalId: professional.id,
        revision: 1,
        displayName: 'سالن ر',
        bio: null,
        cityId: null,
        cityName: null,
        specialtyIds: [],
        specialtyNames: [],
        verificationStatus: 'verified',
        isDeleted: false,
        updatedAt: new Date(),
        services: [],
      });

      for (let i = 0; i < 4; i += 1) {
        const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, `+98913000019${i}`);
        await request(app.getHttpServer())
          .post(`/api/v1/bookings/${bookingId}/review`)
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ rating: 5 })
          .expect(201);
      }
      await drainUntilQuiet();

      let [doc] = await dataSource.query(
        'SELECT ranking_signal_keys FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc.ranking_signal_keys).not.toContain('high_rating');

      const fifth = await completeBookingFor(professional, pro.accessToken, '+989130000195');
      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${fifth.bookingId}/review`)
        .set('Authorization', `Bearer ${fifth.customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);
      await drainUntilQuiet();

      [doc] = await dataSource.query(
        'SELECT ranking_signal_keys, ranking_score FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc.ranking_signal_keys).toContain('high_rating');
      expect(Number(doc.ranking_score)).toBeGreaterThan(0);
    });

  });

  // ---------------------------------------------------------------- reading

  describe('reading', () => {
    it('lists published reviews publicly and hides hidden ones', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000200', 'سالن ز');
      const a = await completeBookingFor(professional, pro.accessToken, '+989130000201');
      const b = await completeBookingFor(professional, pro.accessToken, '+989130000202');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${a.bookingId}/review`)
        .set('Authorization', `Bearer ${a.customer.accessToken}`)
        .send({ rating: 5, comment: 'بسیار عالی' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${b.bookingId}/review`)
        .set('Authorization', `Bearer ${b.customer.accessToken}`)
        .send({ rating: 4 })
        .expect(201);

      // Public: no session at all.
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/reviews`)
        .expect(200);
      expect(listed.body.data).toHaveLength(2);
      expect(listed.body.meta.pagination.total).toBe(2);

      // The reviewer's identity is never in the public shape: publishing it
      // would let anyone assemble one customer's visit history from public data.
      expect(listed.body.data[0]).not.toHaveProperty('customerId');

      const moderator = await seedUser(app, dataSource, '+989130000203', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${first.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${await tokenFor(moderator.id)}`)
        .send({ decision: 'hide', reason: 'تبلیغات' })
        .expect(201);

      const afterHide = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/reviews`)
        .expect(200);
      expect(afterHide.body.data).toHaveLength(1);
    });

    it("lets a customer see their own reviews, including one that was hidden", async () => {
      const { proUser: pro, professional } = await seedPro('+989130000210', 'سالن ژ');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000211');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 3, comment: 'متوسط' })
        .expect(201);

      const moderator = await seedUser(app, dataSource, '+989130000212', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${await tokenFor(moderator.id)}`)
        .send({ decision: 'hide', reason: 'خارج از موضوع' })
        .expect(201);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/me/reviews')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);

      // The author can see what happened to their own words. Nobody else can.
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0].status).toBe('hidden');
      expect(mine.body.data[0].bookingId).toBe(bookingId);
    });
  });

  // --------------------------------------------------------------- response

  describe("the professional's reply", () => {
    it('publishes a reply on their own review', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000220', 'سالن س');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000221');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 4 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/reviews/${created.body.data.id}/respond`)
        .set('Authorization', `Bearer ${pro.accessToken}`)
        .send({ text: 'ممنون از بازخورد شما' })
        .expect(201);

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/reviews`)
        .expect(200);
      expect(listed.body.data[0].response.text).toBe('ممنون از بازخورد شما');
    });

    it("refuses a reply to another professional's review", async () => {
      const { proUser: proA, professional: a } = await seedPro('+989130000230', 'سالن ش');
      const { proUser: proB, professional: b } = await seedPro('+989130000231', 'سالن ص');
      const { customer, bookingId } = await completeBookingFor(a, proA.accessToken, '+989130000232');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 2 })
        .expect(201);

      // Through B's own profile id, so the ownership guard passes and only the
      // service's own professional scoping refuses -- the second of the two
      // checks, tested in isolation from the first.
      await request(app.getHttpServer())
        .post(`/api/v1/providers/${b.id}/reviews/${created.body.data.id}/respond`)
        .set('Authorization', `Bearer ${proB.accessToken}`)
        .send({ text: 'پاسخ' })
        .expect(404);

      // And through A's profile id with B's session, so the ownership guard is
      // the one that refuses.
      await request(app.getHttpServer())
        .post(`/api/v1/providers/${a.id}/reviews/${created.body.data.id}/respond`)
        .set('Authorization', `Bearer ${proB.accessToken}`)
        .send({ text: 'پاسخ' })
        .expect(404);
    });

    it('refuses a reply from a customer', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000240', 'سالن ض');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000241');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/reviews/${created.body.data.id}/respond`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ text: 'من صاحب این پروفایل نیستم' })
        .expect(404);
    });
  });

  // ------------------------------------------------------------- moderation

  describe('moderation', () => {
    it('queues untriaged reviews, and a decision drains the queue either way', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000250', 'سالن ط');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000251');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5, comment: 'خیلی خوب' })
        .expect(201);

      const moderator = await seedUser(app, dataSource, '+989130000252', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      const queued = await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/queue')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .expect(200);
      expect(queued.body.data).toHaveLength(1);
      // A moderator reads the text: deciding whether it stays up is the job.
      expect(queued.body.data[0].comment).toBe('خیلی خوب');

      // Deciding to KEEP it drains the queue without changing visibility. Without
      // that, the only way to clear a queue would be to hide things.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ decision: 'publish', reason: 'بررسی شد و مشکلی ندارد' })
        .expect(201);

      const drained = await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/queue')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .expect(200);
      expect(drained.body.data).toHaveLength(0);

      // Still public, and still counted.
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/reviews`)
        .expect(200);
      expect(listed.body.data).toHaveLength(1);
    });

    it('writes an audit row naming the actor, and never the review text', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000260', 'سالن ظ');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000261');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 1, comment: 'متن خصوصی که نباید در لاگ بیاید' })
        .expect(201);

      const moderator = await seedUser(app, dataSource, '+989130000262', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
        .set('Authorization', `Bearer ${await tokenFor(moderator.id)}`)
        .send({ decision: 'hide', reason: 'نقض قوانین' })
        .expect(201);

      const audit = await dataSource.query(
        'SELECT action, actor_user_id, before_state, after_state FROM admin.admin_audit_log WHERE target_id = $1',
        [created.body.data.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe('provider.review_hidden');
      expect(audit[0].actor_user_id).toBe(moderator.id);

      // Customer-authored prose is excluded by construction from the audit
      // snapshot, exactly as it is from the event payload.
      expect(JSON.stringify(audit[0])).not.toContain('متن خصوصی');
    });

    it('never carries the review text in the event payload either', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000270', 'سالن ع');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000271');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5, comment: 'این متن هرگز نباید در رویداد باشد' })
        .expect(201);

      const [row] = await dataSource.query(
        "SELECT payload FROM provider.outbox_events WHERE event_type = 'ReviewCreated'",
      );
      // The outbox is the widest distribution channel in this architecture:
      // every consumer, persisted, replayable. The exclusion has to hold here
      // or it holds nowhere.
      expect(JSON.stringify(row.payload)).not.toContain('این متن');
      expect(row.payload.rating).toBe(5);
    });

    it('refuses the queue and the decision to a customer and to a platform operator', async () => {
      const customer = await seedUser(app, dataSource, '+989130000280', ['customer']);
      await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/queue')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(403);

      // `bc_moderate_reviews` is content moderation and is deliberately NOT
      // held by platform_operator -- the separation the roles migration
      // reasoned through, asserted rather than assumed.
      const operator = await seedUser(app, dataSource, '+989130000281', ['customer']);
      await bootstrapRole(operator.id, 'platform_operator');
      await request(app.getHttpServer())
        .get('/api/v1/admin/reviews/queue')
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .expect(403);
    });

    it('produces one decision when two moderators act simultaneously', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000290', 'سالن غ');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000291');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 2 })
        .expect(201);

      const one = await seedUser(app, dataSource, '+989130000292', ['customer']);
      const two = await seedUser(app, dataSource, '+989130000293', ['customer']);
      await bootstrapRole(one.id, 'moderator');
      await bootstrapRole(two.id, 'moderator');
      const [tokenOne, tokenTwo] = [await tokenFor(one.id), await tokenFor(two.id)];

      const results = await Promise.all(
        [tokenOne, tokenTwo].map((token) =>
          request(app.getHttpServer())
            .post(`/api/v1/admin/reviews/${created.body.data.id}/moderate`)
            .set('Authorization', `Bearer ${token}`)
            .send({ decision: 'hide', reason: 'بررسی هم‌زمان' }),
        ),
      );

      // Exactly one wins — whether the two transactions genuinely overlap or
      // the second lands after the first has committed. Both paths matter:
      // the overlapping one is caught by the row lock, and the sequential one
      // by the `status <> toStatus OR moderated_at IS NULL` clause, which is
      // the half this test found missing.
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      // And the trail names the moderator who actually made the decision.
      const [row] = await dataSource.query('SELECT moderated_by FROM provider.reviews WHERE id = $1', [
        created.body.data.id,
      ]);
      expect([one.id, two.id]).toContain(row.moderated_by);
      const audit = await dataSource.query('SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE target_id = $1', [
        created.body.data.id,
      ]);
      expect(audit[0].n).toBe(1);
    });
  });

  // ----------------------------------------------------------------- loyalty

  describe('loyalty', () => {
    it('awards the review points that have been configured and unreachable since Phase 3', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000300', 'سالن ف');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000301');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5 })
        .expect(201);
      await drainUntilQuiet();

      const entries = await dataSource.query(
        "SELECT points, reason FROM loyalty.points_entries WHERE user_id = $1 AND reason = 'review_submitted'",
        [customer.id],
      );
      expect(entries).toHaveLength(1);
      // LOYALTY_POINTS_REVIEW_SUBMITTED, pinned at 5 by the test harness.
      expect(Number(entries[0].points)).toBe(5);

      // A redelivery must not award twice -- the ledger's UNIQUE index on
      // (reference_type, reference_id, reason) is what stops it.
      await dataSource.query("UPDATE provider.outbox_events SET published_at = NULL WHERE event_type = 'ReviewCreated'");
      await drainUntilQuiet();

      const after = await dataSource.query(
        "SELECT count(*)::int AS n FROM loyalty.points_entries WHERE user_id = $1 AND reason = 'review_submitted'",
        [customer.id],
      );
      expect(after[0].n).toBe(1);
    });
  });

  // --------------------------------------------------------------- analytics

  describe('analytics', () => {
    it('records the review as a provider-subject fact, with the rating but not the text', async () => {
      const { proUser: pro, professional } = await seedPro('+989130000310', 'سالن ق');
      const { customer, bookingId } = await completeBookingFor(professional, pro.accessToken, '+989130000311');

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 4, comment: 'نظر خصوصی' })
        .expect(201);
      await drainUntilQuiet();

      const [row] = await dataSource.query(
        "SELECT subject_type, subject_id, dimensions FROM analytics.events WHERE event_type = 'ReviewCreated'",
      );
      expect(row.subject_type).toBe('provider');
      expect(row.subject_id).toBe(professional.id);
      expect(row.dimensions.rating).toBe(4);
      expect(JSON.stringify(row)).not.toContain('نظر خصوصی');
    });
  });
});
