import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { OBJECT_STORAGE_DRIVER, ObjectStorageDriver, pngFixture, presignS3Url } from '@beauclick/media';
import { ERROR_REPORTER, ErrorReport, ErrorReporterPort } from '@beauclick/observability';

import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedProfessional, seedUser } from './pg-test-app.factory';

// Credentials come from the environment and are never defaulted, exactly as in
// `media-s3.pg-spec.ts`: a committed fallback is a committed credential.
const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? '';
const ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? '';
const BUCKET = process.env.TEST_S3_BUCKET ?? '';
const REGION = 'us-east-1';
const configured = Boolean(requiredPgEnv() && ENDPOINT && ACCESS_KEY && SECRET_KEY && BUCKET);

const describeS3 = configured ? describe : describe.skip;

/**
 * #265 on the S3 driver: the inspection URL is served from real object storage,
 * never points at it, and a store that has lost the bytes is the shared refusal.
 *
 * `media-inspection.pg-spec.ts` proves the contract on the local driver; this
 * file boots the application on `MEDIA_STORAGE_DRIVER=s3` against a real
 * S3-compatible server (MinIO in CI), because the two drivers read, head and
 * fail differently, and the refusal must not depend on which one is deployed.
 * A separate file because the harness snapshots configuration per file.
 */
describeS3('#265 -- inspecting a reported image on the S3 driver (real PostgreSQL, real object storage)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let storage: ObjectStorageDriver;
  let reporter: ErrorReporterPort;
  const logged: string[] = [];
  const reports: ErrorReport[] = [];

  beforeAll(async () => {
    const create = await fetch(
      presignS3Url(
        { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: REGION, endpoint: ENDPOINT, bucket: BUCKET, forcePathStyle: true },
        { method: 'PUT', objectKey: '', expiresInSeconds: 60 },
      ),
      { method: 'PUT' },
    );
    expect([200, 409]).toContain(create.status);

    ctx = await createPgTestApp({
      MEDIA_STORAGE_DRIVER: 's3',
      MEDIA_S3_ENDPOINT: ENDPOINT,
      MEDIA_S3_ACCESS_KEY_ID: ACCESS_KEY,
      MEDIA_S3_SECRET_ACCESS_KEY: SECRET_KEY,
      MEDIA_S3_BUCKET: BUCKET,
      MEDIA_S3_REGION: REGION,
      MEDIA_S3_FORCE_PATH_STYLE: 'true',
      MEDIA_S3_PUBLIC_BASE_URL: `${ENDPOINT}/${BUCKET}`,
    });
    app = ctx.app;
    dataSource = ctx.dataSource;
    storage = app.get(OBJECT_STORAGE_DRIVER);
    reporter = app.get(ERROR_REPORTER);
    // The app really is on S3: otherwise this file proves nothing new.
    expect(storage.key).toBe('s3');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    logged.length = 0;
    reports.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '));
      });
    }
    jest.spyOn(reporter, 'capture').mockImplementation(async (report: ErrorReport) => {
      reports.push(report);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  let seq = 0;
  const phone = () => `+98915365${String((seq += 1)).padStart(4, '0')}`;

  /** A portfolio image uploaded to real object storage through its presigned grant, then reported. */
  async function reportedOnS3() {
    const owner = await seedUser(app, dataSource, phone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
    const bytes = pngFixture(520, 390);
    const grant = await request(app.getHttpServer())
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ purpose: 'portfolio', contentType: 'image/png', byteSize: bytes.length })
      .expect(201);
    const { mediaId, upload } = grant.body.data;
    expect(upload.url.startsWith(ENDPOINT)).toBe(true);
    const put = await fetch(upload.url, { method: 'PUT', body: bytes, headers: upload.headers });
    expect(put.status).toBe(200);
    await request(app.getHttpServer()).post(`/api/v1/media/${mediaId}/finalize`).set('Authorization', `Bearer ${owner.accessToken}`).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/providers/${professional.id}/portfolio`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaId })
      .expect(201);

    const reporterUser = await seedUser(app, dataSource, phone(), ['customer']);
    const report = await request(app.getHttpServer())
      .post(`/api/v1/media/${mediaId}/report`)
      .set('Authorization', `Bearer ${reporterUser.accessToken}`)
      .send({ reason: 'explicit' })
      .expect(201);
    const moderator = await seedUser(app, dataSource, phone(), ['moderator']);
    const [{ storage_key: storageKey }] = await dataSource.query('SELECT storage_key FROM media.objects WHERE id = $1', [mediaId]);
    return { mediaId, reportId: report.body.data.id as string, moderator, storageKey: storageKey as string, bytes };
  }

  const inspect = (reportId: string, bearer: string) =>
    request(app.getHttpServer()).get(`/api/v1/admin/media/reports/${reportId}/inspection`).set('Authorization', `Bearer ${bearer}`);
  const fetchUrl = (inspectionUrl: string) => {
    const url = new URL(inspectionUrl);
    return request(app.getHttpServer()).get(`${url.pathname}${url.search}`);
  };

  it('serves the exact bytes from object storage through the API, never pointing at the store', async () => {
    const { mediaId, reportId, moderator, storageKey, bytes } = await reportedOnS3();
    const minted = await inspect(reportId, moderator.accessToken).expect(200);
    const { inspectionUrl } = minted.body.data;

    expect(new URL(inspectionUrl).pathname).toBe(`/api/v1/media/${mediaId}/content`);
    const text = JSON.stringify(minted.body);
    for (const storageFact of [ENDPOINT, BUCKET, storageKey, new URL(ENDPOINT).host, 'X-Amz-']) {
      expect(text).not.toContain(storageFact);
    }

    const served = await fetchUrl(inspectionUrl).expect(200);
    expect(Buffer.compare(served.body as Buffer, bytes)).toBe(0);
    expect(served.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses, with the shared refusal and no 500, once the store has lost the bytes', async () => {
    const { reportId, moderator, storageKey } = await reportedOnS3();
    const refusal = (await inspect(uuidv7(), moderator.accessToken).expect(404)).body;
    const minted = await inspect(reportId, moderator.accessToken).expect(200);

    await storage.delete(storageKey);
    expect((await storage.head(storageKey)).exists).toBe(false);

    expect((await inspect(reportId, moderator.accessToken).expect(404)).body).toEqual(refusal);
    expect((await fetchUrl(minted.body.data.inspectionUrl).expect(404)).body).toEqual(refusal);
    expect(reports).toEqual([]);

    // The store's own error text (its URL, bucket and key) is not logged; the
    // warning names the object id only -- and the capture is proven to see it.
    const everything = logged.join('\n');
    expect(everything).toContain('could not be read for an authorized viewer');
    const token = new URL(minted.body.data.inspectionUrl).searchParams.get('token') as string;
    for (const secret of [ENDPOINT, BUCKET, storageKey, token, 'X-Amz-']) {
      expect(everything).not.toContain(secret);
    }
  });
});
