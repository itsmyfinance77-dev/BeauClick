import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RoleService } from '@beauclick/identity';
import { MediaService, PROTECTED_DOWNLOAD_TTL_SECONDS, jpegFixture, pngFixture } from '@beauclick/media';
import { ERROR_REPORTER, ErrorReport, ErrorReporterPort, METRICS, MetricsRegistry } from '@beauclick/observability';

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
 * #265 -- a media moderator can look at the image a report is about before the
 * irreversible «تأیید و حذف», against real PostgreSQL and the real local store.
 *
 * `media-portfolio.pg-spec.ts` already proves the report/decide mechanics. This
 * file proves the inspection contract `52_MODERATOR_LANDING.md` §5 and §7 ask
 * for: the URL is resolved from the REPORT, minted for one moderator, expires,
 * is re-authorized live on every request, cannot reach anything else, and
 * every reason it cannot be inspected is the one shared refusal. And that the
 * URL, its token and the object's storage key never reach a log line, a metric,
 * an error report, an audit row or an error body -- each channel scanned with a
 * positive canary first, so a scan that finds nothing is known to be looking.
 */
describePg('#265 -- safe inspection of a reported image (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let media: MediaService;
  let roles: RoleService;
  let metrics: MetricsRegistry;
  let reporter: ErrorReporterPort;

  const NO_MEDIA_ROLE = 'test_265_moderator_without_media';
  /** Read after the harness has set it: `createPgTestApp` writes the hermetic env. */
  let mediaRoot = '';

  // ------------------------------------------------------------ capture

  /**
   * Everything logged while a case runs. Two sinks, because the harness has
   * two: Nest's testing logger PRINTS only errors, so a `warn` never reaches
   * stdout here -- every call on a `Logger` is captured at the call instead,
   * with its arguments, and anything printed is captured as well.
   */
  let written: string[] = [];
  let reports: ErrorReport[] = [];
  const restorers: Array<() => void> = [];

  function captureOutput(): void {
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restorers.push(() => {
        stream.write = original as typeof stream.write;
      });
    }
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      const spy = jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, ...args: unknown[]) {
        written.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '));
      });
      restorers.push(() => spy.mockRestore());
    }
  }

  /** The secrets of one inspection URL, and the storage identity it must never reveal. */
  function secretsOf(inspectionUrl: string, storageKey: string): string[] {
    const url = new URL(inspectionUrl);
    const token = url.searchParams.get('token') ?? '';
    const [body, mac] = token.split('.');
    return [inspectionUrl, `${url.pathname}${url.search}`, token, body, mac, storageKey, join(mediaRoot, storageKey), mediaRoot].filter(
      (value) => value.length > 0,
    );
  }

  const found = (haystack: string, needles: string[]) => needles.filter((needle) => haystack.includes(needle));

  async function auditText(): Promise<string> {
    const rows = await dataSource.query('SELECT * FROM admin.admin_audit_log');
    return JSON.stringify(rows);
  }

  // ------------------------------------------------------------ fixtures

  async function tokenFor(userId: string): Promise<string> {
    const access = await roles.resolveAccess(userId);
    return app.get(JwtService).sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  async function upload(token: string, purpose: string, bytes: Buffer, contentType = 'image/png'): Promise<string> {
    const grant = await request(app.getHttpServer())
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose, contentType, byteSize: bytes.length })
      .expect(201);
    const { mediaId, upload: target } = grant.body.data;
    await request(app.getHttpServer()).put(new URL(target.url).pathname).set('content-type', contentType).send(bytes).expect(204);
    await request(app.getHttpServer())
      .post(`/api/v1/media/${mediaId}/finalize`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    return mediaId;
  }

  let phoneSeq = 0;
  const phone = () => `+98915265${String((phoneSeq += 1)).padStart(4, '0')}`;

  /** A published portfolio image with one open report against it, and a moderator. */
  async function reported(bytes = pngFixture(640, 480)) {
    const owner = await seedUser(app, dataSource, phone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
    const mediaId = await upload(owner.accessToken, 'portfolio', bytes);
    await request(app.getHttpServer())
      .post(`/api/v1/providers/${professional.id}/portfolio`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaId })
      .expect(201);

    const reporterUser = await seedUser(app, dataSource, phone(), ['customer']);
    const report = await request(app.getHttpServer())
      .post(`/api/v1/media/${mediaId}/report`)
      .set('Authorization', `Bearer ${reporterUser.accessToken}`)
      .send({ reason: 'explicit', note: 'یادداشت گزارش‌دهنده' })
      .expect(201);

    const moderator = await seedUser(app, dataSource, phone(), ['moderator']);
    const [{ storage_key: storageKey }] = await dataSource.query('SELECT storage_key FROM media.objects WHERE id = $1', [mediaId]);
    return { owner, mediaId, reportId: report.body.data.id as string, moderator, storageKey: storageKey as string, bytes };
  }

  const inspect = (reportId: string, bearer: string) =>
    request(app.getHttpServer()).get(`/api/v1/admin/media/reports/${reportId}/inspection`).set('Authorization', `Bearer ${bearer}`);

  const fetchUrl = (inspectionUrl: string) => {
    const url = new URL(inspectionUrl);
    return request(app.getHttpServer()).get(`${url.pathname}${url.search}`);
  };

  /** A token the service would sign, with claims a real caller cannot choose. The adversary's best case. */
  function signed(claims: { m: string; u: string; e: number; r?: string }): string {
    const sign = (media as unknown as { signDownloadToken: (m: string, u: string, e: number, r?: string) => string }).signDownloadToken.bind(
      media,
    );
    return sign(claims.m, claims.u, claims.e, claims.r);
  }
  const inAMinute = () => Math.floor(Date.now() / 1000) + 60;

  /** The refusal every "cannot be inspected" reason must produce, byte for byte. */
  let sharedRefusal: unknown;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    media = app.get(MediaService);
    roles = app.get(RoleService);
    metrics = app.get(MetricsRegistry);
    reporter = app.get(ERROR_REPORTER);
    mediaRoot = resolve(process.env.MEDIA_LOCAL_ROOT ?? '');
    expect(mediaRoot).toContain('beauclick-pg-test-media');
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM identity.user_roles WHERE role_slug = $1`, [NO_MEDIA_ROLE]);
    await dataSource.query(`DELETE FROM identity.roles WHERE slug = $1`, [NO_MEDIA_ROLE]);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    metrics.reset();
    written = [];
    reports = [];
    captureOutput();
    const capture = jest.spyOn(reporter, 'capture').mockImplementation(async (report: ErrorReport) => {
      reports.push(report);
    });
    restorers.push(() => capture.mockRestore());

    const moderator = await seedUser(app, dataSource, phone(), ['moderator']);
    sharedRefusal = (await inspect(uuidv7(), moderator.accessToken).expect(404)).body;
  });

  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------ the happy path

  describe('a media moderator', () => {
    it('gets a short-lived URL for exactly the reported image, never its public URL or storage identity', async () => {
      const { mediaId, reportId, moderator, storageKey, bytes } = await reported();

      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      expect(Object.keys(minted.body.data).sort()).toEqual(['expiresAt', 'id', 'inspectionUrl']);
      expect(minted.body.data.id).toBe(reportId);
      // A response carrying a live token is never stored by a shared cache.
      expect(minted.headers['cache-control']).toBe('private, no-store');

      const url = new URL(minted.body.data.inspectionUrl);
      expect(url.pathname).toBe(`/api/v1/media/${mediaId}/content`);
      expect([...url.searchParams.keys()]).toEqual(['token']);
      expect(minted.body.data.inspectionUrl).not.toContain(storageKey);
      expect(minted.body.data.inspectionUrl).not.toContain('/media/file/');
      expect(JSON.stringify(minted.body)).not.toMatch(/public\/portfolio|bucket|storage|key/i);

      const claims = JSON.parse(Buffer.from(url.searchParams.get('token')!.split('.')[0], 'base64url').toString('utf8'));
      expect(claims).toEqual({ m: mediaId, u: moderator.id, e: expect.any(Number), r: reportId });
      const lifetime = claims.e - Math.floor(Date.now() / 1000);
      expect(lifetime).toBeGreaterThan(PROTECTED_DOWNLOAD_TTL_SECONDS - 30);
      expect(lifetime).toBeLessThanOrEqual(PROTECTED_DOWNLOAD_TTL_SECONDS);
      // What the panel is told is exactly what the token enforces.
      expect(new Date(minted.body.data.expiresAt).getTime()).toBe(claims.e * 1000);

      const served = await fetchUrl(minted.body.data.inspectionUrl).expect(200);
      expect(Buffer.compare(served.body as Buffer, bytes)).toBe(0);
      expect(served.headers['content-type']).toContain('image/png');
      expect(served.headers['cache-control']).toBe('private, no-store');
      // Not relaxed the way the public route relaxes it. (helmet's same-origin
      // default is applied in `main.ts`, outside this harness; the web app
      // renders through a CORS-mode <img crossorigin>, which the allow-list
      // governs -- proven against the built API in a real browser.)
      expect(served.headers['cross-origin-resource-policy']).not.toBe('cross-origin');
      expect(served.headers['content-disposition']).toBeUndefined();
    });

    it('is refused a URL for an image the report is not about, even with a validly signed token', async () => {
      const a = await reported();
      const b = await reported(pngFixture(300, 300));

      // Report A's token presented at image B's address.
      const minted = await inspect(a.reportId, a.moderator.accessToken).expect(200);
      const token = new URL(minted.body.data.inspectionUrl).searchParams.get('token');
      const crossed = await request(app.getHttpServer()).get(`/api/v1/media/${b.mediaId}/content?token=${token}`).expect(404);
      expect(crossed.body).toEqual(sharedRefusal);

      // The adversary's best case: a token genuinely signed for image B under
      // report A. The association is re-read, so it still does not open.
      const foreign = signed({ m: b.mediaId, u: a.moderator.id, e: inAMinute(), r: a.reportId });
      expect((await request(app.getHttpServer()).get(`/api/v1/media/${b.mediaId}/content?token=${foreign}`).expect(404)).body).toEqual(
        sharedRefusal,
      );

      // And an association that changes after minting closes the URL too.
      await dataSource.query('UPDATE media.abuse_reports SET media_object_id = $1 WHERE id = $2', [b.mediaId, a.reportId]);
      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
    });
  });

  // ------------------------------------------------------ who may inspect

  describe('who may inspect', () => {
    it('refuses a moderator without bc_moderate_media, an operator and a customer, at the route', async () => {
      const { reportId } = await reported();

      await dataSource.query(`DELETE FROM identity.user_roles WHERE role_slug = $1`, [NO_MEDIA_ROLE]);
      await dataSource.query(`DELETE FROM identity.roles WHERE slug = $1`, [NO_MEDIA_ROLE]);
      await dataSource.query(
        `INSERT INTO identity.roles (slug, name, description, is_privileged, is_default)
         VALUES ($1, 'Moderator without media (test)', '#265 fixture', true, false)`,
        [NO_MEDIA_ROLE],
      );
      for (const capability of ['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_chat']) {
        await dataSource.query(`INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES ($1, $2)`, [
          NO_MEDIA_ROLE,
          capability,
        ]);
      }
      const partial = await seedUser(app, dataSource, phone(), ['customer']);
      await dataSource.query(`INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason) VALUES ($1, $2, NULL, 'test')`, [
        partial.id,
        NO_MEDIA_ROLE,
      ]);
      const partialToken = await tokenFor(partial.id);
      expect(JSON.parse(Buffer.from(partialToken.split('.')[1], 'base64url').toString()).capabilities).toEqual(
        expect.arrayContaining(['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_chat']),
      );
      await inspect(reportId, partialToken).expect(403);

      const operator = await seedUser(app, dataSource, phone(), ['platform_operator']);
      await inspect(reportId, operator.accessToken).expect(403);

      const customer = await seedUser(app, dataSource, phone(), ['customer']);
      await inspect(reportId, customer.accessToken).expect(403);
      await request(app.getHttpServer()).get(`/api/v1/admin/media/reports/${reportId}/inspection`).expect(401);
    });

    it('refuses an inflated token that merely CLAIMS bc_moderate_media, at the route and at the bytes', async () => {
      const { mediaId, reportId } = await reported();
      const customer = await seedUser(app, dataSource, phone(), ['customer']);
      const inflated = app.get(JwtService).sign({ sub: customer.id, roles: ['customer', 'moderator'], capabilities: ['bc_moderate_media'] });
      await inspect(reportId, inflated).expect(403);

      // A validly signed inspection token naming that customer opens nothing.
      const token = signed({ m: mediaId, u: customer.id, e: inAMinute(), r: reportId });
      expect((await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${token}`).expect(404)).body).toEqual(
        sharedRefusal,
      );
    });

    it('closes an unexpired URL, and refuses the same session, the moment the capability is revoked', async () => {
      const { reportId, moderator } = await reported();
      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      await fetchUrl(minted.body.data.inspectionUrl).expect(200);

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'moderator'`, [moderator.id]);

      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
      // The same, still-valid JWT that still claims the capability.
      await inspect(reportId, moderator.accessToken).expect(403);
    });

    it('does not let the image OWNER use an inspection token, and does not let one open anything else', async () => {
      const { owner, mediaId, reportId } = await reported();

      // The owner's shortcut in `canView` belongs to protected downloads only.
      const ownerToken = signed({ m: mediaId, u: owner.id, e: inAMinute(), r: reportId });
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${ownerToken}`).expect(404);

      // A plain (report-less) token never opens a PUBLIC object, even for its owner.
      const plain = signed({ m: mediaId, u: owner.id, e: inAMinute() });
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${plain}`).expect(404);
    });
  });

  // ------------------------------------------------ the shared refusal

  describe('everything that cannot be inspected gets the one shared refusal', () => {
    it('unknown, malformed and already-decided reports', async () => {
      const { reportId, moderator } = await reported();
      expect((await inspect(uuidv7(), moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      expect((await inspect('not-a-uuid', moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      expect((await inspect("x'%20OR%201=1", moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);

      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ decision: 'reject', reason: 'گزارش بی‌مورد است' })
        .expect(201);
      // Decided: no new URL, and the one already minted is closed.
      expect((await inspect(reportId, moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
    });

    it('a deleted, a pending and a private (protected) object, and an object whose bytes are gone', async () => {
      // Deleted by its owner after the report.
      const deleted = await reported();
      const before = await inspect(deleted.reportId, deleted.moderator.accessToken).expect(200);
      await dataSource.query("UPDATE media.objects SET status = 'deleted', deleted_at = now() WHERE id = $1", [deleted.mediaId]);
      expect((await inspect(deleted.reportId, deleted.moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      expect((await fetchUrl(before.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);

      // Back to pending (never finalized).
      const pending = await reported();
      await dataSource.query("UPDATE media.objects SET status = 'pending' WHERE id = $1", [pending.mediaId]);
      expect((await inspect(pending.reportId, pending.moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);

      // A report row against PROTECTED evidence cannot be made through the API;
      // written directly, it still opens nothing -- no evidence via this door.
      const professional = await seedUser(app, dataSource, phone(), ['professional']);
      await seedProfessional(dataSource, professional.id, 'متقاضی');
      const evidenceId = await upload(professional.accessToken, 'verification_evidence', jpegFixture(800, 600), 'image/jpeg');
      const evidenceReport = uuidv7();
      await dataSource.query(
        `INSERT INTO media.abuse_reports (id, media_object_id, reported_by, reason, status) VALUES ($1, $2, $3, 'other', 'open')`,
        [evidenceReport, evidenceId, professional.id],
      );
      const moderator = await seedUser(app, dataSource, phone(), ['moderator']);
      expect((await inspect(evidenceReport, moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      const evidenceToken = signed({ m: evidenceId, u: moderator.id, e: inAMinute(), r: evidenceReport });
      expect(
        (await request(app.getHttpServer()).get(`/api/v1/media/${evidenceId}/content?token=${evidenceToken}`).expect(404)).body,
      ).toEqual(sharedRefusal);

      // Bytes gone from the store while the row still says `stored`.
      const lost = await reported();
      const minted = await inspect(lost.reportId, lost.moderator.accessToken).expect(200);
      await fs.rm(join(mediaRoot, lost.storageKey));
      expect((await inspect(lost.reportId, lost.moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
      // Not a 500 whose driver error would name the path.
      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
      expect(reports).toEqual([]);
    });

    it('an expired, a tampered and a missing token', async () => {
      const { mediaId, reportId, moderator } = await reported();
      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      await fetchUrl(minted.body.data.inspectionUrl).expect(200);

      // Past the lifetime the route minted it with.
      const realNow = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + (PROTECTED_DOWNLOAD_TTL_SECONDS + 1) * 1000);
      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
      clock.mockRestore();
      await fetchUrl(minted.body.data.inspectionUrl).expect(200);

      const expired = signed({ m: mediaId, u: moderator.id, e: Math.floor(Date.now() / 1000) - 1, r: reportId });
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${expired}`).expect(404);

      const token = new URL(minted.body.data.inspectionUrl).searchParams.get('token')!;
      const [body, mac] = token.split('.');
      const widened = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), e: inAMinute() + 86_400 }),
      ).toString('base64url');
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${widened}.${mac}`).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content`).expect(404);
      await request(app.getHttpServer()).get(`/api/v1/media/${mediaId}/content?token=${token}&token=${token}`).expect(404);
    });
  });

  // ------------------------------------------- decisions are unchanged

  describe('the decision itself is unchanged', () => {
    it('rejects without any inspection, with its reason and audit semantics', async () => {
      const { mediaId, reportId, moderator } = await reported();
      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ decision: 'reject', reason: 'گزارش بی‌مورد است' })
        .expect(201);

      const [object] = await dataSource.query('SELECT status FROM media.objects WHERE id = $1', [mediaId]);
      expect(object.status).toBe('stored');
      const audit = await dataSource.query('SELECT action, actor_user_id, reason, before_state AS before, after_state AS after FROM admin.admin_audit_log WHERE target_id = $1', [
        mediaId,
      ]);
      expect(audit).toEqual([
        {
          action: 'media.abuse_report_rejected',
          actor_user_id: moderator.id,
          reason: 'گزارش بی‌مورد است',
          before: { status: 'stored', reportStatus: 'open' },
          after: { status: 'stored', reportId },
        },
      ]);
    });

    it('upholds after inspection exactly as before: one transaction, one audit row, bytes gone, the URL closed', async () => {
      const { mediaId, reportId, moderator, storageKey } = await reported();
      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      await fetchUrl(minted.body.data.inspectionUrl).expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ decision: 'uphold', reason: 'محتوای نامناسب' })
        .expect(201);

      const [object] = await dataSource.query('SELECT status, taken_down_by FROM media.objects WHERE id = $1', [mediaId]);
      expect(object).toEqual({ status: 'deleted', taken_down_by: moderator.id });
      const audit = await dataSource.query('SELECT action, actor_user_id, reason, before_state AS before, after_state AS after FROM admin.admin_audit_log WHERE target_id = $1', [
        mediaId,
      ]);
      expect(audit).toEqual([
        {
          action: 'media.abuse_report_upheld',
          actor_user_id: moderator.id,
          reason: 'محتوای نامناسب',
          before: { status: 'stored', reportStatus: 'open' },
          after: { status: 'deleted', reportId },
        },
      ]);
      await expect(fs.stat(join(mediaRoot, storageKey))).rejects.toThrow();
      expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(sharedRefusal);
      expect((await inspect(reportId, moderator.accessToken).expect(404)).body).toEqual(sharedRefusal);
    });
  });

  // ------------------------------------------------------ leak scans

  describe('the URL, token and storage identity never leak', () => {
    it('into logs, metrics, error reports, audit rows or error bodies -- each scan proven by a canary', async () => {
      const { reportId, moderator, storageKey, mediaId } = await reported();
      const minted = await inspect(reportId, moderator.accessToken).expect(200);
      const secrets = secretsOf(minted.body.data.inspectionUrl, storageKey);
      expect(secrets.length).toBeGreaterThanOrEqual(8);

      const bodies: string[] = [];
      // Exercise every path that can log, count or report: success, refusals,
      // a lost object (the one path that logs a warning), and both decisions.
      await fetchUrl(minted.body.data.inspectionUrl).expect(200);
      const url = new URL(minted.body.data.inspectionUrl);
      const token = url.searchParams.get('token')!;
      bodies.push(JSON.stringify((await request(app.getHttpServer()).get(`/api/v1/media/${uuidv7()}/content?token=${token}`)).body));
      bodies.push(JSON.stringify((await request(app.getHttpServer()).get(`${url.pathname}?token=${token}x`)).body));
      bodies.push(JSON.stringify((await inspect(uuidv7(), moderator.accessToken)).body));
      await fs.rm(join(mediaRoot, storageKey));
      bodies.push(JSON.stringify((await fetchUrl(minted.body.data.inspectionUrl)).body));
      bodies.push(JSON.stringify((await inspect(reportId, moderator.accessToken)).body));
      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ decision: 'uphold', reason: 'محتوای نامناسب' })
        .expect(201);
      const other = await reported();
      await inspect(other.reportId, other.moderator.accessToken).expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/media/reports/${other.reportId}/decide`)
        .set('Authorization', `Bearer ${other.moderator.accessToken}`)
        .send({ decision: 'reject', reason: 'گزارش بی‌مورد است' })
        .expect(201);

      const logs = written.join('');
      const rendered = metrics.render();
      const reported_ = JSON.stringify(reports);
      const audit = await auditText();

      // The warning for the lost object WAS written, and names the object only.
      expect(logs).toContain(`Stored object ${mediaId} could not be read`);
      expect(found(logs, secrets)).toEqual([]);
      expect(found(rendered, secrets)).toEqual([]);
      expect(rendered).toContain('/v1/media/:id/content');
      expect(rendered).toContain('/v1/admin/media/reports/:id/inspection');
      expect(found(reported_, secrets)).toEqual([]);
      expect(found(audit, secrets)).toEqual([]);
      expect(audit).toContain(reportId);
      expect(found(bodies.join('\n'), secrets)).toEqual([]);
      expect(bodies.every((body) => body === JSON.stringify(sharedRefusal))).toBe(true);

      // POSITIVE CANARIES: the same scans, on the same channels, DO find a
      // secret when one is actually there. Without these, every `toEqual([])`
      // above could be a scan of an empty or unrelated string.
      new Logger('MediaService').warn(`canary ${token}`);
      expect(found(written.join(''), [token])).toEqual([token]);
      metrics.increment(METRICS.httpRequests, { method: 'GET', route: `canary-${storageKey}`, status: '2xx' });
      expect(found(metrics.render(), [storageKey])).toEqual([storageKey]);
      reports.push({ error: { name: 'Error', message: token }, level: 'error' } as unknown as ErrorReport);
      expect(found(JSON.stringify(reports), [token])).toEqual([token]);
      expect(found(JSON.stringify(minted.body), secrets)).toEqual(expect.arrayContaining([minted.body.data.inspectionUrl, token]));
      // The audit log is append-only for the application role, so the canary
      // is a fresh row with its own target, carrying a marker that is no secret.
      const marker = `canary-265-${uuidv7()}`;
      await dataSource.query(
        `INSERT INTO admin.admin_audit_log (id, actor_user_id, action, target_type, target_id, reason, before_state, after_state)
         VALUES ($1, $2, 'test.canary_265', 'media_object', $3, NULL, $4::jsonb, '{}'::jsonb)`,
        [uuidv7(), moderator.id, uuidv7(), JSON.stringify({ marker })],
      );
      expect(found(await auditText(), [marker])).toEqual([marker]);
    });
  });
});
