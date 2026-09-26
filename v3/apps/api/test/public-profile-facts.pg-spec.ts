import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BookingService } from '@beauclick/booking';
import { RoleService } from '@beauclick/identity';
import { pngFixture } from '@beauclick/media';
import { PortfolioService } from '@beauclick/provider';
import { InMemorySearchEngine, PUBLIC_PROVIDER_IMAGERY, SEARCH_ENGINE, SearchIndexerService } from '@beauclick/search';
import type { PublicProviderImageryPort } from '@beauclick/search';

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
 * #226 -- public profile facts, against real PostgreSQL.
 *
 *  1. A search result carries the professional's public `images` (the SAME shape
 *     `GET /v1/providers/:id` returns) and a `portfolioCount` over their whole
 *     public portfolio -- read from the authoritative rows, never from the
 *     search index, so a moderator's takedown reaches it.
 *  2. The provider detail route carries `completedBookingCount`, defined once
 *     (`countPublicCompletedBookings`) and evaluated against the SERVER's clock.
 *
 * What is NOT here: the pg-mem layer (`public-profile-facts.e2e-spec.ts`) covers
 * the count's status/professional/request-independence cases; this file adds
 * what only a real server can prove -- the database clock, the real booking
 * lifecycle, real media rows, real moderation and a measured statement count.
 */
describePg('#226 public profile facts (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let roles: RoleService;
  let indexer: SearchIndexerService;
  let engine: InMemorySearchEngine;
  let bookings: BookingService;
  let phoneSeq = 0;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    roles = app.get(RoleService);
    indexer = app.get(SearchIndexerService);
    engine = app.get(SEARCH_ENGINE) as InMemorySearchEngine;
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    engine.reset();
    engine.available = true;
  });

  // ---------------------------------------------------------------- helpers

  function nextPhone(): string {
    phoneSeq += 1;
    return `+98915${String(phoneSeq).padStart(7, '0')}`;
  }

  async function tokenFor(userId: string): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const access = await roles.resolveAccess(userId);
    return app.get(JwtService).sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  async function upload(token: string, purpose: string, bytes: Buffer): Promise<string> {
    const grant = await request(app.getHttpServer())
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose, contentType: 'image/png', byteSize: bytes.length })
      .expect(201);
    const { mediaId, upload: target } = grant.body.data;
    await request(app.getHttpServer())
      .put(new URL(target.url).pathname)
      .set('content-type', 'image/png')
      .send(bytes)
      .expect(204);
    await request(app.getHttpServer())
      .post(`/api/v1/media/${mediaId}/finalize`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    return mediaId;
  }

  interface Seller {
    userId: string;
    professionalId: string;
    token: string;
    serviceId: string;
  }

  /** A professional who exists in the search index, with no imagery yet. */
  async function seller(displayName: string, over: Record<string, unknown> = {}): Promise<Seller> {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, user.id, displayName);
    await indexer.applyProfessional({
      professionalId: professional.id,
      revision: 1,
      displayName,
      bio: null,
      cityId: null,
      cityName: 'یزد',
      specialtyIds: [],
      specialtyNames: [],
      verificationStatus: 'verified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [],
      ...over,
    });
    await indexer.flushDirty();
    return { userId: user.id, professionalId: professional.id, token: user.accessToken, serviceId: professional.serviceId };
  }

  async function setAvatar(s: Seller): Promise<string> {
    const mediaId = await upload(s.token, 'avatar', pngFixture(512, 512));
    await request(app.getHttpServer())
      .patch(`/api/v1/providers/${s.professionalId}/avatar`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ mediaId })
      .expect(204);
    return mediaId;
  }

  async function setCover(s: Seller): Promise<string> {
    const mediaId = await upload(s.token, 'cover', pngFixture(1200, 500));
    await request(app.getHttpServer())
      .patch(`/api/v1/providers/${s.professionalId}/cover`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ mediaId })
      .expect(204);
    return mediaId;
  }

  async function addWork(s: Seller, count = 1): Promise<string[]> {
    const mediaIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const mediaId = await upload(s.token, 'portfolio', pngFixture(600 + i, 400));
      await request(app.getHttpServer())
        .post(`/api/v1/providers/${s.professionalId}/portfolio`)
        .set('Authorization', `Bearer ${s.token}`)
        .send({ mediaId })
        .expect(201);
      mediaIds.push(mediaId);
    }
    return mediaIds;
  }

  async function search(query: Record<string, unknown> = {}, token?: string) {
    const req = request(app.getHttpServer()).get('/api/v1/search/providers').query(query);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return (await req.expect(200)).body.data;
  }

  /** The public result shape, loosely typed: the tests are asserting the wire, not our own types. */
  interface SearchItem {
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    images: { avatar: any; cover: any };
    portfolioCount: number;
    saved: boolean | null;
  }
  const itemOf = (data: { items: SearchItem[] }, id: string) => data.items.find((i) => i.id === id);

  async function detail(professionalId: string) {
    return (await request(app.getHttpServer()).get(`/api/v1/providers/${professionalId}`).expect(200)).body.data;
  }

  // =========================================================== search imagery

  describe('search results: images and portfolioCount', () => {
    it("carries exactly the `images` the provider detail route returns, and the whole portfolio's count", async () => {
      const s = await seller('سالن تصویر');
      await setAvatar(s);
      await setCover(s);
      await addWork(s, 3);

      const found = itemOf(await search(), s.professionalId)!;
      const profile = await detail(s.professionalId);

      // One shape for both surfaces -- deep-equal, not merely "both have a url".
      expect(found.images).toEqual(profile.images);
      expect(found.images.avatar).toMatchObject({ contentType: 'image/png', width: 512, height: 512 });
      expect(found.images.avatar.url).toEqual(expect.stringContaining('/v1/media/file/public/avatar/'));
      expect(found.images.cover).toMatchObject({ width: 1200, height: 500 });
      expect(found.portfolioCount).toBe(3);
    });

    it('counts the whole portfolio, not the slice a card draws', async () => {
      // The projection's own preview list is capped at four; the count must not be.
      const s = await seller('سالن پرکار');
      await addWork(s, 6);

      expect(itemOf(await search(), s.professionalId)!.portfolioCount).toBe(6);
    });

    it('reports a professional with nothing uploaded as explicit nulls and zero, never absent', async () => {
      const s = await seller('بدون تصویر');

      const found = itemOf(await search(), s.professionalId)!;
      expect(found.images).toEqual({ avatar: null, cover: null });
      expect(found.portfolioCount).toBe(0);
    });

    it('keeps one professional’s images and count off every other professional', async () => {
      const a = await seller('الف');
      const b = await seller('ب');
      const c = await seller('ج');
      const avatarA = await setAvatar(a);
      const avatarB = await setAvatar(b);
      await addWork(a, 2);
      await addWork(b, 5);

      const data = await search();
      const [ra, rb, rc] = [a, b, c].map((s) => itemOf(data, s.professionalId)!);
      expect(ra.images.avatar.id).toBe(avatarA);
      expect(rb.images.avatar.id).toBe(avatarB);
      expect(ra.images.avatar.id).not.toBe(rb.images.avatar.id);
      expect([ra.portfolioCount, rb.portfolioCount, rc.portfolioCount]).toEqual([2, 5, 0]);
      expect(rc.images).toEqual({ avatar: null, cover: null });
    });

    it('does not change a professional’s portfolioCount with the page they appear on', async () => {
      const sellers = [await seller('اول'), await seller('دوم'), await seller('سوم')];
      await addWork(sellers[0], 1);
      await addWork(sellers[1], 2);
      await addWork(sellers[2], 3);

      const whole = await search({ pageSize: 20 });
      const expected = new Map<string, number>(
        whole.items.map((i: { id: string; portfolioCount: number }) => [i.id, i.portfolioCount]),
      );
      expect(expected.size).toBe(3);

      const seen = new Map<string, number>();
      for (const page of [1, 2, 3]) {
        const paged = await search({ pageSize: 1, page });
        expect(paged.items).toHaveLength(1);
        seen.set(paged.items[0].id, paged.items[0].portfolioCount);
      }
      expect(seen).toEqual(expected);
      expect([...expected.values()].sort()).toEqual([1, 2, 3]);
    });

    it.each([
      ['pending', "UPDATE media.objects SET status = 'pending' WHERE id = $1"],
      ['deleted', "UPDATE media.objects SET status = 'deleted', deleted_at = now() WHERE id = $1"],
      ['protected', "UPDATE media.objects SET access_class = 'protected' WHERE id = $1"],
    ])('never lets a %s object become an image or add to the count', async (_label, sql) => {
      const s = await seller('استثنا');
      const avatarId = await setAvatar(s);
      const coverId = await setCover(s);
      const [workId] = await addWork(s, 2);
      await dataSource.query(sql, [avatarId]);
      await dataSource.query(sql, [coverId]);
      await dataSource.query(sql, [workId]);

      const found = itemOf(await search(), s.professionalId)!;
      expect(found.images).toEqual({ avatar: null, cover: null });
      expect(found.portfolioCount).toBe(1);
    });

    it('drops a removed portfolio item from the count immediately', async () => {
      const s = await seller('حذف');
      await addWork(s, 3);
      const items = (await request(app.getHttpServer()).get(`/api/v1/providers/${s.professionalId}/portfolio`).expect(200)).body.data;
      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${s.professionalId}/portfolio/${items[0].id}`)
        .set('Authorization', `Bearer ${s.token}`)
        .expect(204);

      expect(itemOf(await search(), s.professionalId)!.portfolioCount).toBe(2);
    });

    it('follows a moderator’s takedown at once, although the index copy is never told', async () => {
      const s = await seller('اعمال ممیزی');
      const avatarId = await setAvatar(s);
      const [workId] = await addWork(s, 2);
      // Let the projection catch up, so the index copy really does hold the
      // imagery. Without this the case would pass for an implementation that read
      // the index too, because the index would simply be empty.
      for (let pass = 0; pass < 6; pass += 1) {
        if ((await ctx.relay.drain()).dispatched === 0) break;
      }
      await indexer.flushDirty();
      const [held] = await dataSource.query(
        'SELECT avatar_url, portfolio_count FROM search.provider_documents WHERE professional_id = $1',
        [s.professionalId],
      );
      expect(held.avatar_url).not.toBeNull();
      expect(held.portfolio_count).toBe(2);
      expect(itemOf(await search(), s.professionalId)!.portfolioCount).toBe(2);

      const moderator = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await dataSource.query(
        `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason) VALUES ($1, 'moderator', NULL, 'test') ON CONFLICT DO NOTHING`,
        [moderator.id],
      );
      const moderatorToken = await tokenFor(moderator.id);
      const reporter = await seedUser(app, dataSource, nextPhone(), ['customer']);

      for (const mediaId of [avatarId, workId]) {
        const report = await request(app.getHttpServer())
          .post(`/api/v1/media/${mediaId}/report`)
          .set('Authorization', `Bearer ${reporter.accessToken}`)
          .send({ reason: 'explicit' })
          .expect(201);
        await request(app.getHttpServer())
          .post(`/api/v1/admin/media/reports/${report.body.data.id}/decide`)
          .set('Authorization', `Bearer ${moderatorToken}`)
          .send({ decision: 'uphold', reason: 'محتوای نامناسب' })
          .expect(201);
      }

      const found = itemOf(await search(), s.professionalId)!;
      expect(found.images.avatar).toBeNull();
      expect(found.portfolioCount).toBe(1);
      // And the detail route, which reads the same rows, agrees.
      expect((await detail(s.professionalId)).images.avatar).toBeNull();
    });

    it('is the same for an anonymous visitor and a signed-in customer', async () => {
      const s = await seller('همه');
      await setAvatar(s);
      await addWork(s, 2);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const anonymous = itemOf(await search(), s.professionalId)!;
      const signedIn = itemOf(await search({}, customer.accessToken), s.professionalId)!;
      expect(signedIn.images).toEqual(anonymous.images);
      expect(signedIn.portfolioCount).toBe(anonymous.portfolioCount);
      // `saved` is the one field that legitimately differs by caller.
      expect(anonymous.saved).toBeNull();
      expect(signedIn.saved).toBe(false);
    });

    it('is still served when the engine is down and results come from the projection', async () => {
      const s = await seller('کاهش خدمت');
      await setAvatar(s);
      await addWork(s, 2);
      engine.available = false;

      const data = await search();
      expect(data.degraded).toBe(true);
      const found = itemOf(data, s.professionalId)!;
      expect(found.images.avatar).not.toBeNull();
      expect(found.portfolioCount).toBe(2);
    });

    it('serves the results without pictures, and says so in the log, when the imagery read fails', async () => {
      const s = await seller('خطا');
      await setAvatar(s);
      await addWork(s, 2);
      const portfolio = app.get(PortfolioService);
      const failing = jest.spyOn(portfolio, 'publicImageryForMany').mockRejectedValueOnce(new Error('media read failed'));
      const { Logger } = await import('@nestjs/common');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const data = await search();
      failing.mockRestore();

      const found = itemOf(data, s.professionalId)!;
      expect(found.images).toEqual({ avatar: null, cover: null });
      expect(found.portfolioCount).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Public imagery unavailable'));
      warn.mockRestore();
    });

    it('exposes no storage key, moderation state, owner or report information', async () => {
      const s = await seller('بدون افشا');
      await setAvatar(s);
      await addWork(s, 1);

      const wire = JSON.stringify(await search());
      // The URL of a PUBLIC object is the public route for it -- the same one the
      // detail route hands out -- and nothing else about the object rides along.
      const { images } = (JSON.parse(wire) as { items: SearchItem[] }).items[0];
      expect(Object.keys(images.avatar).sort()).toEqual(['contentType', 'height', 'id', 'url', 'width']);
      expect(images.avatar.url).toMatch(/\/v1\/media\/file\/public\/avatar\/[0-9a-f-]{36}$/);
      expect(wire).not.toContain('/protected/');
      expect(wire).not.toMatch(/storageKey|storage_key|accessClass|access_class|ownerUserId|owner_user_id|takenDownBy|taken_down|report/i);
      expect(wire).not.toContain(s.userId);
    });

    it('costs a fixed number of statements however many professionals the page holds', async () => {
      const port = app.get<PublicProviderImageryPort>(PUBLIC_PROVIDER_IMAGERY);
      const sellers: Seller[] = [];
      for (let i = 0; i < 12; i += 1) {
        const s = await seller(`ردیف ${i}`);
        await setAvatar(s);
        await addWork(s, 2);
        sellers.push(s);
      }

      const spy = jest.spyOn(PostgresQueryRunner.prototype, 'query');
      const statementsFor = async (ids: string[]): Promise<number> => {
        spy.mockClear();
        const result = await port.imageryFor(ids);
        expect(result.size).toBe(ids.length);
        return spy.mock.calls.filter(([sql]) => /FROM "(provider|media)"\./.test(String(sql))).length;
      };

      const one = await statementsFor([sellers[0].professionalId]);
      const all = await statementsFor(sellers.map((s) => s.professionalId));
      spy.mockRestore();

      // professionals + live portfolio rows + one describe over every media id.
      expect(one).toBe(3);
      // The N+1 shape would make this 1 + 12 * k.
      expect(all).toBe(one);
    });
  });

  // ================================================= completed-booking count

  describe('the completed-booking count against the server clock', () => {
    const detailCount = async (id: string) => (await detail(id)).completedBookingCount;

    async function bookedAndCompleted(s: Seller, hoursAhead: number) {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const slotId = await seedSlot(dataSource, s.professionalId, s.serviceId, futureSlotTime(hoursAhead));
      const booking = await bookings.create({
        customerId: customer.id,
        professionalId: s.professionalId,
        slotId,
        serviceId: s.serviceId,
      });
      expect(await bookings.confirm(booking.id)).toBe(true);
      return { booking, customer, slotId };
    }

    it('does not count a booking the professional closed out before its appointment, and counts it once it has ended', async () => {
      const s = await seller('زودهنگام');
      const { booking } = await bookedAndCompleted(s, 48);

      // The real lifecycle allows this: complete() has no "has it ended" guard.
      expect(await bookings.complete(booking.id, { type: 'professional', id: s.userId })).toBe(true);
      expect((await bookings.findById(booking.id))?.status).toBe('completed');
      expect(await detailCount(s.professionalId)).toBe(0);

      // Time passes -- here, the appointment is moved into the past -- and the
      // same row now counts, with nobody doing anything to the booking.
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '3 hours', slot_end = now() - interval '2 hours' WHERE id = $1`,
        [booking.id],
      );
      expect(await detailCount(s.professionalId)).toBe(1);
    });

    it('decides "ended" by the database clock, to the second', async () => {
      const s = await seller('ثانیه');
      const { booking } = await bookedAndCompleted(s, 30);
      await bookings.complete(booking.id, { type: 'professional', id: s.userId });
      // Ends two seconds from now BY THE DATABASE, whatever this process thinks the time is.
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '58 minutes', slot_end = now() + interval '2 seconds' WHERE id = $1`,
        [booking.id],
      );
      expect(await detailCount(s.professionalId)).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(await detailCount(s.professionalId)).toBe(1);
    }, 30_000);

    it('counts a rescheduled booking once, by where it finally stood', async () => {
      const s = await seller('جابه‌جا');
      const { booking } = await bookedAndCompleted(s, 40);
      await bookings.complete(booking.id, { type: 'professional', id: s.userId });
      await dataSource.query(
        `UPDATE booking.bookings
            SET reschedule_count = 2, slot_start = now() - interval '5 hours', slot_end = now() - interval '4 hours'
          WHERE id = $1`,
        [booking.id],
      );
      expect(await detailCount(s.professionalId)).toBe(1);
    });

    it('counts only the bookings that reached completed, through the real lifecycle', async () => {
      const s = await seller('مسیر واقعی');
      const done = await bookedAndCompleted(s, 24);
      const cancelled = await bookedAndCompleted(s, 26);
      const stillConfirmed = await bookedAndCompleted(s, 28);
      await bookings.complete(done.booking.id, { type: 'professional', id: s.userId });
      await bookings.cancel(cancelled.booking.id, { type: 'customer', id: cancelled.customer.id }, 'تغییر برنامه');
      // Every appointment long over, so only the STATUS separates them.
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '2 days', slot_end = now() - interval '47 hours' WHERE professional_id = $1`,
        [s.professionalId],
      );

      expect(stillConfirmed.booking.id).toBeDefined();
      expect(await detailCount(s.professionalId)).toBe(1);
    });

    it('is a lifetime figure: an old completed booking still counts', async () => {
      const s = await seller('قدیمی');
      const { booking } = await bookedAndCompleted(s, 24);
      await bookings.complete(booking.id, { type: 'professional', id: s.userId });
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '900 days', slot_end = now() - interval '900 days' + interval '1 hour' WHERE id = $1`,
        [booking.id],
      );
      expect(await detailCount(s.professionalId)).toBe(1);
    });

    it('never counts a completed booking of another professional', async () => {
      const a = await seller('الف');
      const b = await seller('ب');
      const { booking } = await bookedAndCompleted(b, 24);
      await bookings.complete(booking.id, { type: 'professional', id: b.userId });
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '3 hours', slot_end = now() - interval '2 hours' WHERE id = $1`,
        [booking.id],
      );

      expect(await detailCount(a.professionalId)).toBe(0);
      expect(await detailCount(b.professionalId)).toBe(1);
    });

    it('is not on the search result, which would need a count per row', async () => {
      const s = await seller('جست‌وجو');
      const { booking } = await bookedAndCompleted(s, 24);
      await bookings.complete(booking.id, { type: 'professional', id: s.userId });
      await dataSource.query(
        `UPDATE booking.bookings SET slot_start = now() - interval '3 hours', slot_end = now() - interval '2 hours' WHERE id = $1`,
        [booking.id],
      );

      const found = itemOf(await search(), s.professionalId)!;
      expect(found).not.toHaveProperty('completedBookingCount');
      // The ranking signal `completedBookings` is a different, internal fact
      // and stays out of the public response, as it always has.
      expect(found).not.toHaveProperty('completedBookings');
    });

    it('answers an unknown professional exactly as before, with no count in the body', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/providers/${uuidv7()}`).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      expect(JSON.stringify(res.body)).not.toContain('completedBookingCount');
    });
  });

  // ================================================================= /v1/me

  describe('GET /v1/me createdAt', () => {
    it('returns the persisted account instant against a real timestamptz column', async () => {
      const user = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await dataSource.query(`UPDATE identity.users SET created_at = '2025-07-01T08:30:15.123456Z' WHERE id = $1`, [user.id]);

      const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${user.accessToken}`).expect(200);
      // JavaScript's Date holds milliseconds; the API states that, in UTC.
      expect(me.body.data.createdAt).toBe('2025-07-01T08:30:15.123Z');
    });

    it('is refused without a session', async () => {
      await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    });
  });
});
