import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RoleService } from '@beauclick/identity';
import { MediaService, jpegFixture, pdfFixture, pngFixture, svgFixture } from '@beauclick/media';
import { OutboxRelay } from '@beauclick/events';
import { SearchIndexerService } from '@beauclick/search';

import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * V3.1 Phase C -- media, portfolio, and imagery, against real PostgreSQL.
 *
 * WHAT THIS SUITE IS FOR, stated because it is easy to mistake for a happy-path
 * upload test. Presigned direct upload has one structural consequence: the API
 * never sees the request body. Every content rule therefore has to be enforced
 * against bytes read BACK from the store, at a moment strictly after the client
 * has finished, and the whole of the media design follows from that. So the
 * cases below are organised around the four questions that consequence raises:
 *
 *   1. Does a grant authorize exactly one object, and expire?
 *   2. Does finalize actually inspect what arrived, rather than what was
 *      claimed -- including for a file that IS a valid document of another type?
 *   3. Can one professional ever reach another's upload, at any of the four
 *      places a media id is accepted?
 *   4. Is protected content -- verification evidence, a scan of somebody's
 *      identity document -- unreachable without a live authorization check?
 *
 * The fourth is the one that would matter most if it were wrong, so it gets
 * the most adversarial cases.
 */
describePg('V3.1 Phase C -- media, portfolio, imagery (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let media: MediaService;
  let roles: RoleService;

  async function drainUntilQuiet(maxPasses = 6): Promise<void> {
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

  /** A token reflecting the user's CURRENT roles, as a real refresh would produce. */
  async function tokenFor(userId: string): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const access = await roles.resolveAccess(userId);
    return jwt.sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  /**
   * The whole upload journey a browser performs: ask for a grant, PUT the
   * bytes to wherever the grant says, finalize.
   *
   * Driven through real HTTP at every step -- including the PUT, which goes to
   * the URL the driver itself produced rather than to a path this test knows.
   * A helper that wrote to the store directly would skip the exact hop where
   * the token, the key scoping, and the size limit are enforced.
   */
  async function upload(
    token: string,
    purpose: string,
    bytes: Buffer,
    contentType = 'image/png',
  ): Promise<{ mediaId: string; finalize: request.Response }> {
    const grant = await request(app.getHttpServer())
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose, contentType, byteSize: bytes.length })
      .expect(201);

    const { mediaId, upload: target } = grant.body.data;
    const putPath = new URL(target.url).pathname.replace(/^\/api/, '/api');

    await request(app.getHttpServer())
      .put(putPath)
      .set('content-type', contentType)
      .send(bytes)
      .expect(204);

    const finalize = await request(app.getHttpServer())
      .post(`/api/v1/media/${mediaId}/finalize`)
      .set('Authorization', `Bearer ${token}`);

    return { mediaId, finalize };
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    media = app.get(MediaService);
    roles = app.get(RoleService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // -------------------------------------------------------------- the grant

  describe('the upload grant', () => {
    it('issues a target scoped to one key, with an expiry', async () => {
      const user = await seedUser(app, dataSource, '+989120000101', ['professional']);

      const response = await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 4096 })
        .expect(201);

      const { mediaId, upload: target } = response.body.data;
      expect(mediaId).toEqual(expect.any(String));
      expect(target.method).toBe('PUT');
      expect(target.headers['content-type']).toBe('image/png');
      expect(new Date(target.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const [row] = await dataSource.query('SELECT * FROM media.objects WHERE id = $1', [mediaId]);
      expect(row.status).toBe('pending');
      expect(row.owner_user_id).toBe(user.id);
      // The access class is denormalized at creation so a later policy edit
      // cannot retroactively reclassify an object that already exists.
      expect(row.access_class).toBe('public');
      // The key is unguessable and derived from nothing the uploader supplied.
      expect(row.storage_key).toBe(`public/portfolio/${mediaId}`);
    });

    it('refuses an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 4096 })
        .expect(401);
    });

    it('refuses a declared content type outside the allow-list', async () => {
      const user = await seedUser(app, dataSource, '+989120000102', ['professional']);
      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/svg+xml', byteSize: 4096 })
        .expect(400);
    });

    it('refuses a declared size above the purpose cap, before any object exists', async () => {
      const user = await seedUser(app, dataSource, '+989120000103', ['professional']);
      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'avatar', contentType: 'image/png', byteSize: 20 * 1024 * 1024 })
        .expect(400);

      const [{ count }] = await dataSource.query('SELECT count(*)::int FROM media.objects');
      expect(count).toBe(0);
    });

    it('bounds outstanding pending grants, so the endpoint is not an unbounded row factory', async () => {
      const user = await seedUser(app, dataSource, '+989120000104', ['professional']);

      // Quota counts STORED objects, so grants that are never uploaded consume
      // none of it. Without a separate pending bound this route creates rows
      // forever at whatever rate the throttler permits.
      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/media/upload-url')
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
          .expect(201);
      }

      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(409);
    });

    it('reaps expired grants, so a failed upload is not a permanent lockout', async () => {
      const user = await seedUser(app, dataSource, '+989120000105', ['professional']);
      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);

      // Nothing reaped while the grant is still live.
      expect(await media.reapExpiredGrants()).toBe(0);

      // An hour later, past the 15-minute grant TTL.
      expect(await media.reapExpiredGrants(new Date(Date.now() + 3_600_000))).toBe(1);

      const [{ count }] = await dataSource.query(
        "SELECT count(*)::int FROM media.objects WHERE status = 'pending'",
      );
      expect(count).toBe(0);
    });
  });

  // ------------------------------------------------------------- the upload

  describe('the direct upload', () => {
    it('refuses a forged token', async () => {
      await request(app.getHttpServer())
        .put('/api/v1/media/upload/bm90LWEtdG9rZW4.forged')
        .set('content-type', 'image/png')
        .send(pngFixture(400, 400))
        .expect(404);
    });

    it('cuts off a body larger than the grant declared', async () => {
      const user = await seedUser(app, dataSource, '+989120000106', ['professional']);
      const grant = await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);

      const putPath = new URL(grant.body.data.upload.url).pathname;
      // Ten times what was declared. Refused while streaming, not after
      // buffering -- a limit enforced after the fact is not a limit on memory.
      await request(app.getHttpServer())
        .put(putPath)
        .set('content-type', 'image/png')
        .send(pngFixture(400, 400, 10 * 1024))
        .expect(400);
    });
  });

  // ----------------------------------------------------------- the finalize

  describe('finalize inspects what actually arrived', () => {
    it('accepts a real PNG and records its measured type and dimensions', async () => {
      const user = await seedUser(app, dataSource, '+989120000110', ['professional']);
      const { mediaId, finalize } = await upload(user.accessToken, 'portfolio', pngFixture(1200, 800));

      expect(finalize.status).toBe(201);
      expect(finalize.body.data).toMatchObject({ contentType: 'image/png', width: 1200, height: 800 });

      const [row] = await dataSource.query('SELECT * FROM media.objects WHERE id = $1', [mediaId]);
      expect(row.status).toBe('stored');
      expect(row.content_type).toBe('image/png');
      expect(row.width).toBe(1200);
      expect(row.height).toBe(800);
    });

    it('accepts a JPEG whose declared type happened to be PNG, recording the truth', async () => {
      // Not an attack -- a client that got its own MIME detection wrong. The
      // point is that the STORED type is what the bytes are, so nothing
      // downstream serves a wrong content-type header on the strength of a
      // client's guess.
      const user = await seedUser(app, dataSource, '+989120000111', ['professional']);
      const { mediaId } = await upload(user.accessToken, 'portfolio', jpegFixture(640, 480));

      const [row] = await dataSource.query('SELECT content_type FROM media.objects WHERE id = $1', [mediaId]);
      expect(row.content_type).toBe('image/jpeg');
    });

    it('refuses an SVG uploaded under a declared image/png, and deletes it', async () => {
      // THE attack this whole path exists to stop. SVG is an executable
      // document; one served from an origin holding a session is stored XSS.
      // The declared-type allow-list does not catch it -- the client declared
      // image/png -- so the sniff at finalize is the only control.
      const user = await seedUser(app, dataSource, '+989120000112', ['professional']);
      const { mediaId, finalize } = await upload(user.accessToken, 'portfolio', svgFixture());

      expect(finalize.status).toBe(400);

      const [row] = await dataSource.query('SELECT status FROM media.objects WHERE id = $1', [mediaId]);
      // Deleted, not merely left pending: an object that failed validation but
      // stayed in the bucket is storage nobody can see and a backup would
      // faithfully restore.
      expect(row.status).toBe('deleted');
    });

    it('refuses a PDF uploaded under a declared image/png', async () => {
      const user = await seedUser(app, dataSource, '+989120000113', ['professional']);
      const { finalize } = await upload(user.accessToken, 'portfolio', pdfFixture());
      expect(finalize.status).toBe(400);
    });

    it('refuses an image below the minimum edge for its purpose', async () => {
      const user = await seedUser(app, dataSource, '+989120000114', ['professional']);
      const { finalize } = await upload(user.accessToken, 'avatar', pngFixture(50, 50));
      expect(finalize.status).toBe(400);
    });

    it('refuses an image whose dimensions exceed the cap even though its bytes do not', async () => {
      // A decompression bomb: small on disk, enormous in memory. A byte cap
      // alone does not bound what a renderer downstream has to handle.
      const user = await seedUser(app, dataSource, '+989120000115', ['professional']);
      const { finalize } = await upload(user.accessToken, 'avatar', pngFixture(30000, 30000));
      expect(finalize.status).toBe(400);
    });

    it('refuses to finalize an object nobody uploaded', async () => {
      const user = await seedUser(app, dataSource, '+989120000116', ['professional']);
      const grant = await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/media/${grant.body.data.mediaId}/finalize`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it('is idempotent: finalizing twice returns the same stored object', async () => {
      const user = await seedUser(app, dataSource, '+989120000117', ['professional']);
      const { mediaId } = await upload(user.accessToken, 'portfolio', pngFixture(400, 400));

      const second = await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/finalize`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(201);

      expect(second.body.data.id).toBe(mediaId);
    });

    it("refuses to finalize somebody else's object, indistinguishably from a missing one", async () => {
      const owner = await seedUser(app, dataSource, '+989120000118', ['professional']);
      const stranger = await seedUser(app, dataSource, '+989120000119', ['professional']);

      const grant = await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);

      const real = await request(app.getHttpServer())
        .post(`/api/v1/media/${grant.body.data.mediaId}/finalize`)
        .set('Authorization', `Bearer ${stranger.accessToken}`);
      const fabricated = await request(app.getHttpServer())
        .post(`/api/v1/media/${uuidv7()}/finalize`)
        .set('Authorization', `Bearer ${stranger.accessToken}`);

      expect(real.status).toBe(404);
      expect(fabricated.status).toBe(404);
      // Byte-identical, so the endpoint cannot be used to discover which media
      // ids exist.
      expect(real.body.error).toEqual(fabricated.body.error);
    });
  });

  // ------------------------------------------------------------- the quota

  describe('quota', () => {
    it('refuses a grant once the purpose quota is full', async () => {
      const user = await seedUser(app, dataSource, '+989120000120', ['professional']);

      // The avatar quota is 5. Fill it with real, finalized objects.
      for (let i = 0; i < 5; i += 1) {
        const { finalize } = await upload(user.accessToken, 'avatar', pngFixture(400, 400));
        expect(finalize.status).toBe(201);
      }

      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'avatar', contentType: 'image/png', byteSize: 1024 })
        .expect(409);
    });

    it('counts quota per purpose, so a full avatar quota does not block a portfolio upload', async () => {
      const user = await seedUser(app, dataSource, '+989120000121', ['professional']);
      for (let i = 0; i < 5; i += 1) {
        await upload(user.accessToken, 'avatar', pngFixture(400, 400));
      }

      await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);
    });
  });

  // ---------------------------------------------------------- the portfolio

  describe('portfolio', () => {
    it('attaches an upload, exposes it publicly, and serves the bytes', async () => {
      const user = await seedUser(app, dataSource, '+989120000130', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'سالن آزمایشی');
      const { mediaId } = await upload(user.accessToken, 'portfolio', pngFixture(1000, 750));

      const added = await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId, caption: 'کار نمونه' })
        .expect(201);

      expect(added.body.data.media).toMatchObject({ width: 1000, height: 750, contentType: 'image/png' });
      expect(added.body.data.media.url).toEqual(expect.stringContaining('/v1/media/file/public/portfolio/'));

      // Public, with no session at all -- the whole point of a portfolio.
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}/portfolio`)
        .expect(200);
      expect(listed.body.data).toHaveLength(1);

      const url = new URL(added.body.data.media.url);
      const served = await request(app.getHttpServer()).get(url.pathname).expect(200);
      expect(served.headers['content-type']).toContain('image/png');
      // Immutable: an object's bytes never change, because a replacement is a
      // new id.
      expect(served.headers['cache-control']).toContain('immutable');
      // Without this the image loads with a 200 and renders as nothing: the
      // web app is a different origin from the API, and helmet's
      // application-wide `same-origin` default makes a browser refuse to
      // render a cross-origin resource carrying it.
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    it("refuses to attach another professional's upload", async () => {
      // The single most important authorization case in this phase. The route
      // guard proves the PROFILE is yours; only the media claim proves the
      // UPLOAD is.
      const owner = await seedUser(app, dataSource, '+989120000131', ['professional']);
      const attacker = await seedUser(app, dataSource, '+989120000132', ['professional']);
      const attackerProfile = await seedProfessional(dataSource, attacker.id, 'مهاجم');

      const { mediaId } = await upload(owner.accessToken, 'portfolio', pngFixture(400, 400));

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${attackerProfile.id}/portfolio`)
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .send({ mediaId })
        .expect(404);
    });

    it("refuses to attach your own upload to somebody else's profile", async () => {
      const owner = await seedUser(app, dataSource, '+989120000133', ['professional']);
      await seedProfessional(dataSource, owner.id, 'مالک');
      const victim = await seedUser(app, dataSource, '+989120000134', ['professional']);
      const victimProfile = await seedProfessional(dataSource, victim.id, 'قربانی');

      const { mediaId } = await upload(owner.accessToken, 'portfolio', pngFixture(400, 400));

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${victimProfile.id}/portfolio`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ mediaId })
        .expect(404);
    });

    it('refuses to attach an object whose purpose is not portfolio', async () => {
      // Purpose is not a label -- it is what decided the access class. Letting
      // a `verification_evidence` object become a portfolio item would make a
      // protected object publicly addressable.
      const user = await seedUser(app, dataSource, '+989120000135', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'verification_evidence', pngFixture(400, 400));

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(404);
    });

    it('refuses to attach an object that was never finalized', async () => {
      const user = await seedUser(app, dataSource, '+989120000136', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const grant = await request(app.getHttpServer())
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: 1024 })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: grant.body.data.mediaId })
        .expect(404);
    });

    it('removes an item, deletes its object, and stops serving the bytes', async () => {
      const user = await seedUser(app, dataSource, '+989120000137', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'portfolio', pngFixture(400, 400));

      const added = await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(201);
      const publicPath = new URL(added.body.data.media.url).pathname;

      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professional.id}/portfolio/${added.body.data.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);

      await request(app.getHttpServer()).get(publicPath).expect(404);

      const [row] = await dataSource.query('SELECT status FROM media.objects WHERE id = $1', [mediaId]);
      expect(row.status).toBe('deleted');
    });

    it("refuses to remove another professional's item", async () => {
      const owner = await seedUser(app, dataSource, '+989120000138', ['professional']);
      const ownerProfile = await seedProfessional(dataSource, owner.id, 'مالک');
      const attacker = await seedUser(app, dataSource, '+989120000139', ['professional']);
      await seedProfessional(dataSource, attacker.id, 'مهاجم');

      const { mediaId } = await upload(owner.accessToken, 'portfolio', pngFixture(400, 400));
      const added = await request(app.getHttpServer())
        .post(`/api/v1/providers/${ownerProfile.id}/portfolio`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ mediaId })
        .expect(201);

      // Addressed through the owner's own profile id, so the ownership
      // resolver is what refuses -- not a coincidence of routing.
      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${ownerProfile.id}/portfolio/${added.body.data.id}`)
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .expect(404);
    });

    it('reuses a freed slot rather than growing positions without bound', async () => {
      const user = await seedUser(app, dataSource, '+989120000140', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');

      const first = await upload(user.accessToken, 'portfolio', pngFixture(400, 400));
      const a = await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: first.mediaId })
        .expect(201);
      expect(a.body.data.position).toBe(0);

      await request(app.getHttpServer())
        .delete(`/api/v1/providers/${professional.id}/portfolio/${a.body.data.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);

      const second = await upload(user.accessToken, 'portfolio', pngFixture(400, 400));
      const b = await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: second.mediaId })
        .expect(201);
      expect(b.body.data.position).toBe(0);
    });
  });

  // ------------------------------------------------------- avatar and cover

  describe('profile imagery', () => {
    it('sets an avatar and exposes it on the public profile', async () => {
      const user = await seedUser(app, dataSource, '+989120000150', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'avatar', pngFixture(512, 512));

      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(204);

      const profile = await request(app.getHttpServer())
        .get(`/api/v1/providers/${professional.id}`)
        .expect(200);
      expect(profile.body.data.images.avatar).toMatchObject({ width: 512, height: 512 });
    });

    it('deletes the superseded object when the avatar is replaced', async () => {
      // Otherwise every edit leaks an object and the quota drifts upward until
      // a professional who has changed their photo six times cannot change it
      // again.
      const user = await seedUser(app, dataSource, '+989120000151', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');

      const first = await upload(user.accessToken, 'avatar', pngFixture(512, 512));
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: first.mediaId })
        .expect(204);

      const second = await upload(user.accessToken, 'avatar', pngFixture(600, 600));
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: second.mediaId })
        .expect(204);

      const [old] = await dataSource.query('SELECT status FROM media.objects WHERE id = $1', [first.mediaId]);
      expect(old.status).toBe('deleted');
    });

    it('clears the avatar when null is sent explicitly', async () => {
      const user = await seedUser(app, dataSource, '+989120000152', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'avatar', pngFixture(512, 512));

      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(204);
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: null })
        .expect(204);

      const profile = await request(app.getHttpServer()).get(`/api/v1/providers/${professional.id}`).expect(200);
      expect(profile.body.data.images.avatar).toBeNull();
    });

    it('refuses a portfolio object as an avatar', async () => {
      const user = await seedUser(app, dataSource, '+989120000153', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'portfolio', pngFixture(512, 512));

      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(404);
    });
  });

  // ----------------------------------------------------- protected evidence

  describe('verification evidence is protected content', () => {
    async function submitWithEvidence(phone: string) {
      const user = await seedUser(app, dataSource, phone, ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متقاضی');
      // seedProfessional creates a `verified` professional; verification can
      // only be submitted from a state the machine allows.
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1", [
        professional.id,
      ]);

      const submitted = await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ note: 'مدارک پیوست است' })
        .expect(201);

      const { mediaId } = await upload(user.accessToken, 'verification_evidence', jpegFixture(1000, 700));
      await request(app.getHttpServer())
        .post('/api/v1/verification/evidence')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(201);

      return { user, professional, requestId: submitted.body.data.id, mediaId };
    }

    it('never exposes a public URL for evidence, anywhere', async () => {
      const { mediaId } = await submitWithEvidence('+989120000160');

      const [row] = await dataSource.query('SELECT access_class, storage_key FROM media.objects WHERE id = $1', [
        mediaId,
      ]);
      expect(row.access_class).toBe('protected');

      // Not addressable through the public route even by exact key: that route
      // consults the row, and the row says protected.
      await request(app.getHttpServer())
        .get(`/api/v1/media/file/protected/verification_evidence/${mediaId}`)
        .expect(404);
    });

    it('lets the submitter read back their own evidence', async () => {
      const { user } = await submitWithEvidence('+989120000161');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/verification/me/evidence')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(listed.body.data).toHaveLength(1);
      const url = new URL(listed.body.data[0].downloadUrl);
      const served = await request(app.getHttpServer())
        .get(`${url.pathname}${url.search}`)
        .expect(200);
      expect(served.headers['content-type']).toContain('image/jpeg');
      // A protected object behind a short-lived URL that a shared cache stored
      // is a protected object that leaked.
      expect(served.headers['cache-control']).toContain('no-store');
      // And it keeps the strict application-wide resource policy: only the
      // public route relaxes it.
      expect(served.headers['cross-origin-resource-policy']).not.toBe('cross-origin');
    });

    it('lets a moderator read it, and refuses an authenticated non-moderator', async () => {
      const { requestId } = await submitWithEvidence('+989120000162');

      const moderator = await seedUser(app, dataSource, '+989120000163', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/admin/verification/${requestId}/evidence`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .expect(200);
      const url = new URL(listed.body.data[0].downloadUrl);
      await request(app.getHttpServer()).get(`${url.pathname}${url.search}`).expect(200);

      // An ordinary authenticated user cannot even LIST it, let alone read it.
      const nosy = await seedUser(app, dataSource, '+989120000164', ['professional']);
      await request(app.getHttpServer())
        .get(`/api/v1/admin/verification/${requestId}/evidence`)
        .set('Authorization', `Bearer ${nosy.accessToken}`)
        .expect(403);
    });

    it('refuses a download URL minted for a moderator whose capability has since been revoked', async () => {
      // The property `V3_SECURITY_MODEL.md` §8 asks for in one sentence: the
      // access-control check happens on EVERY request, not once when the link
      // was made. Without the live re-check, a URL minted while somebody was a
      // moderator keeps working after they stop being one.
      const { requestId } = await submitWithEvidence('+989120000165');

      const moderator = await seedUser(app, dataSource, '+989120000166', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/admin/verification/${requestId}/evidence`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .expect(200);
      const url = new URL(listed.body.data[0].downloadUrl);

      await request(app.getHttpServer()).get(`${url.pathname}${url.search}`).expect(200);

      await dataSource.query("DELETE FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'moderator'", [
        moderator.id,
      ]);

      // Same URL, same unexpired token, no longer a moderator.
      await request(app.getHttpServer()).get(`${url.pathname}${url.search}`).expect(404);
    });

    it('refuses a download with no token, a forged token, or a token for a different object', async () => {
      const { mediaId } = await submitWithEvidence('+989120000167');
      const other = await submitWithEvidence('+989120000168');

      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content`).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=forged.mac`).expect(404);

      // A legitimately minted token for a DIFFERENT object must not open this
      // one -- the media id is inside what was signed, not merely in the path.
      const legitimate = media.issueProtectedDownloadUrl('http://x', other.mediaId, other.user.id);
      const stolenToken = new URL(legitimate).searchParams.get('token');
      await request(app.getHttpServer())
        .get(`/api/v1/media/${mediaId}/content?token=${stolenToken}`)
        .expect(404);
    });

    it('refuses evidence attached to a request that is not the caller\'s own open one', async () => {
      const stranger = await seedUser(app, dataSource, '+989120000169', ['professional']);
      await seedProfessional(dataSource, stranger.id, 'بی‌ربط');
      const { mediaId } = await upload(stranger.accessToken, 'verification_evidence', pngFixture(400, 400));

      // No open request: attaching would leave evidence bound to nothing.
      await request(app.getHttpServer())
        .post('/api/v1/verification/evidence')
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({ mediaId })
        .expect(409);
    });
  });

  // ------------------------------------------------------- abuse and takedown

  describe('abuse reports', () => {
    async function publishedItem(phone: string) {
      const user = await seedUser(app, dataSource, phone, ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'portfolio', pngFixture(600, 600));
      const added = await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId })
        .expect(201);
      return { user, professional, mediaId, publicPath: new URL(added.body.data.media.url).pathname };
    }

    it('takes an image down on an upheld report, and writes an audit row', async () => {
      const { mediaId, publicPath } = await publishedItem('+989120000170');
      const reporter = await seedUser(app, dataSource, '+989120000171', ['customer']);
      const moderator = await seedUser(app, dataSource, '+989120000172', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      const report = await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'not_own_work', note: 'این تصویر متعلق به شخص دیگری است' })
        .expect(201);

      await request(app.getHttpServer()).get(publicPath).expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${report.body.data.id}/decide`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ decision: 'uphold', reason: 'تصویر متعلق به متخصص دیگری است' })
        .expect(201);

      await request(app.getHttpServer()).get(publicPath).expect(404);

      const [row] = await dataSource.query('SELECT status, taken_down_by FROM media.objects WHERE id = $1', [mediaId]);
      expect(row.status).toBe('deleted');
      // A takedown is somebody else's decision about your work, so it is
      // distinguishable in the data from you deleting it yourself.
      expect(row.taken_down_by).toBe(moderator.id);

      const audit = await dataSource.query(
        'SELECT action, actor_user_id FROM admin.admin_audit_log WHERE target_id = $1',
        [mediaId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe('media.abuse_report_upheld');
      expect(audit[0].actor_user_id).toBe(moderator.id);
    });

    it('leaves the image up on a rejected report, and still audits the decision', async () => {
      const { mediaId, publicPath } = await publishedItem('+989120000173');
      const reporter = await seedUser(app, dataSource, '+989120000174', ['customer']);
      const moderator = await seedUser(app, dataSource, '+989120000175', ['customer']);
      await bootstrapRole(moderator.id, 'moderator');
      const moderatorToken = await tokenFor(moderator.id);

      const report = await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'other' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${report.body.data.id}/decide`)
        .set('Authorization', `Bearer ${moderatorToken}`)
        .send({ decision: 'reject', reason: 'گزارش بی‌مورد است' })
        .expect(201);

      await request(app.getHttpServer()).get(publicPath).expect(200);
      const audit = await dataSource.query('SELECT action FROM admin.admin_audit_log WHERE target_id = $1', [mediaId]);
      expect(audit[0].action).toBe('media.abuse_report_rejected');
    });

    it('refuses the queue and the decision to a platform operator', async () => {
      // The deliberate authority boundary: `bc_moderate_media` is content
      // moderation and is NOT held by platform_operator, exactly as
      // `bc_moderate_reviews` is not. Approving a verification must not
      // silently confer the power to remove somebody's published work.
      const operator = await seedUser(app, dataSource, '+989120000176', ['customer']);
      await bootstrapRole(operator.id, 'platform_operator');
      const operatorToken = await tokenFor(operator.id);

      await request(app.getHttpServer())
        .get('/api/v1/admin/media/reports')
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(403);
    });

    it('refuses a report against a protected object, so the endpoint is no existence oracle', async () => {
      const user = await seedUser(app, dataSource, '+989120000177', ['professional']);
      await seedProfessional(dataSource, user.id, 'متخصص');
      const { mediaId } = await upload(user.accessToken, 'verification_evidence', pngFixture(400, 400));

      const reporter = await seedUser(app, dataSource, '+989120000178', ['customer']);
      const real = await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'other' });
      const fabricated = await request(app.getHttpServer())
        .post(`/api/v1/media/${uuidv7()}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'other' });

      expect(real.status).toBe(404);
      expect(real.body.error).toEqual(fabricated.body.error);
    });

    it('accepts one open report per reporter per object', async () => {
      const { mediaId } = await publishedItem('+989120000179');
      const reporter = await seedUser(app, dataSource, '+989120000180', ['customer']);

      await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'other' })
        .expect(201);

      // The partial unique index is what refuses the second, so one user
      // cannot inflate a queue a human has to read.
      const second = await request(app.getHttpServer())
        .post(`/api/v1/media/${mediaId}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ reason: 'other' });
      expect(second.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ----------------------------------------------------- the search signal

  describe('the search projection', () => {
    it('carries avatar and portfolio through to the search document', async () => {
      const user = await seedUser(app, dataSource, '+989120000190', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'سالن زیبایی نمونه');

      // A profile event first, so the search document exists at all.
      const indexer = app.get(SearchIndexerService);
      await indexer.applyProfessional({
        professionalId: professional.id,
        revision: 1,
        displayName: 'سالن زیبایی نمونه',
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

      const avatar = await upload(user.accessToken, 'avatar', pngFixture(512, 512));
      await request(app.getHttpServer())
        .patch(`/api/v1/providers/${professional.id}/avatar`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: avatar.mediaId })
        .expect(204);

      const work = await upload(user.accessToken, 'portfolio', pngFixture(900, 600));
      await request(app.getHttpServer())
        .post(`/api/v1/providers/${professional.id}/portfolio`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ mediaId: work.mediaId })
        .expect(201);

      await drainUntilQuiet();

      const [doc] = await dataSource.query(
        'SELECT avatar_url, avatar_width, avatar_height, portfolio_count, portfolio_preview_urls FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc.avatar_url).toEqual(expect.stringContaining('/v1/media/file/public/avatar/'));
      // The dimensions are the whole mechanism behind "zero layout shift": a
      // result card cannot reserve space without them.
      expect(doc.avatar_width).toBe(512);
      expect(doc.avatar_height).toBe(512);
      expect(doc.portfolio_count).toBe(1);
      expect(doc.portfolio_preview_urls).toHaveLength(1);
    });

    it('discards a media event older than what the document already has', async () => {
      const user = await seedUser(app, dataSource, '+989120000191', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const indexer = app.get(SearchIndexerService);

      await indexer.applyProfessional({
        professionalId: professional.id,
        revision: 10,
        displayName: 'متخصص',
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

      expect(
        await indexer.applyMedia({
          professionalId: professional.id,
          revision: 11,
          avatarUrl: 'https://example.test/new.png',
          avatarWidth: 100,
          avatarHeight: 100,
          portfolioCount: 2,
          portfolioPreviewUrls: [],
        }),
      ).toBe(true);

      // A redelivery of an OLDER media event. The dangerous case is not the
      // duplicate -- it is the stale one silently reverting newer data.
      expect(
        await indexer.applyMedia({
          professionalId: professional.id,
          revision: 5,
          avatarUrl: 'https://example.test/stale.png',
          avatarWidth: 1,
          avatarHeight: 1,
          portfolioCount: 0,
          portfolioPreviewUrls: [],
        }),
      ).toBe(false);

      const [doc] = await dataSource.query(
        'SELECT avatar_url, portfolio_count FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc.avatar_url).toBe('https://example.test/new.png');
      expect(doc.portfolio_count).toBe(2);
    });

    it('does not blank imagery when an unrelated profile edit arrives', async () => {
      // The bug this exists to prevent: `applyProfessional` upserting the whole
      // row and wiping the columns a different event owns. A professional
      // editing their bio must not lose their avatar.
      const user = await seedUser(app, dataSource, '+989120000192', ['professional']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص');
      const indexer = app.get(SearchIndexerService);

      await indexer.applyProfessional({
        professionalId: professional.id,
        revision: 1,
        displayName: 'متخصص',
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
      await indexer.applyMedia({
        professionalId: professional.id,
        revision: 2,
        avatarUrl: 'https://example.test/avatar.png',
        avatarWidth: 300,
        avatarHeight: 300,
        portfolioCount: 3,
        portfolioPreviewUrls: ['https://example.test/1.png'],
      });

      await indexer.applyProfessional({
        professionalId: professional.id,
        revision: 3,
        displayName: 'متخصص',
        bio: 'شرح تازه',
        cityId: null,
        cityName: null,
        specialtyIds: [],
        specialtyNames: [],
        verificationStatus: 'verified',
        isDeleted: false,
        updatedAt: new Date(),
        services: [],
      });

      const [doc] = await dataSource.query(
        'SELECT bio, avatar_url, portfolio_count FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc.bio).toBe('شرح تازه');
      expect(doc.avatar_url).toBe('https://example.test/avatar.png');
      expect(doc.portfolio_count).toBe(3);
    });
  });
});
