import { ConfigService } from '@nestjs/config';

import { S3ObjectStorageDriver, pngFixture, presignS3Url } from '@beauclick/media';

// Credentials are supplied by the environment and are NEVER defaulted here.
// A committed fallback is a committed credential: it survives rotation, it is
// searchable in history, and it silently re-points the suite at whatever server
// happens to accept it. Missing configuration must skip loudly, not guess.
const ENDPOINT = process.env.TEST_S3_ENDPOINT;
const configured = Boolean(
  ENDPOINT &&
    process.env.TEST_S3_ACCESS_KEY_ID &&
    process.env.TEST_S3_SECRET_ACCESS_KEY &&
    process.env.TEST_S3_BUCKET,
);

// Empty-string defaults, never a real credential. They exist only so the
// constants below stay `string`; every use sits inside `describeS3`, which is
// skipped unless all four variables are actually present, so an empty value can
// never reach a server. An empty key also cannot authenticate anywhere.
const ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? '';
const BUCKET = process.env.TEST_S3_BUCKET ?? '';
const REGION = 'us-east-1';

const describeS3 = configured ? describe : describe.skip;

/**
 * The S3 driver, against a real S3-compatible server.
 *
 * WHY THIS SUITE HAS TO EXIST, and why nothing cheaper substitutes for it.
 *
 * `sigv4.ts` is a hand-written implementation of a cryptographic signing
 * algorithm. The honest risk of hand-writing one is that it looks right and is
 * wrong -- and a unit test comparing its intermediate strings against values
 * the same file produced would be a tautology dressed as verification. The
 * only thing that can vouch for a signature is a server that either accepts it
 * or does not.
 *
 * So every case below performs a REAL HTTP request to a real S3 API, using a
 * URL this codebase signed. A wrong signature cannot pass any of them.
 *
 * WHAT THIS STILL DOES NOT PROVE, recorded rather than implied: MinIO is the
 * reference implementation of the protocol, not the vendor this platform will
 * actually deploy against -- which is undecided, and downstream of the hosting
 * decision (`V3.1_PRODUCT_ROADMAP.md` §12 #1). `GAP-C-01` records that gap,
 * exactly as `GAP-06b` records the equivalent for the payment gateway. The
 * distinction matters and is not smoothed over: this suite proves the
 * PROTOCOL, not the provider.
 */
describeS3('V3.1 Phase C -- the S3 driver against a real S3-compatible server', () => {
  const signerConfig = {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: REGION,
    endpoint: ENDPOINT ?? '',
    bucket: BUCKET,
    forcePathStyle: true,
  };

  function driver(): S3ObjectStorageDriver {
    // A real ConfigService over a plain map, so the driver's own
    // required-variable checks run exactly as they would at boot.
    const config = new ConfigService({
      MEDIA_S3_ENDPOINT: ENDPOINT,
      MEDIA_S3_ACCESS_KEY_ID: ACCESS_KEY,
      MEDIA_S3_SECRET_ACCESS_KEY: SECRET_KEY,
      MEDIA_S3_BUCKET: BUCKET,
      MEDIA_S3_REGION: REGION,
      MEDIA_S3_FORCE_PATH_STYLE: 'true',
      MEDIA_S3_PUBLIC_BASE_URL: `${ENDPOINT}/${BUCKET}`,
    });
    return new S3ObjectStorageDriver(config);
  }

  /** Uploads through the presigned target the driver produced, as a browser would. */
  async function putThroughGrant(key: string, body: Buffer, contentType = 'image/png'): Promise<Response> {
    const target = await driver().createUploadTarget({
      objectKey: key,
      contentType,
      declaredByteSize: body.length,
      expiresInSeconds: 120,
      accessClass: 'public',
    });
    return fetch(target.url, { method: target.method, body, headers: { 'content-type': contentType } });
  }

  beforeAll(async () => {
    // Create the bucket using this codebase's OWN signer. If the signature
    // were wrong, the suite would fail here rather than misattributing it to
    // whichever case ran first.
    const create = await fetch(presignS3Url(signerConfig, { method: 'PUT', objectKey: '', expiresInSeconds: 60 }), {
      method: 'PUT',
    });
    // 200 for a new bucket; 409 when a previous run already made it.
    expect([200, 409]).toContain(create.status);
  });

  it('signs an upload target the store accepts', async () => {
    const key = `public/portfolio/${Date.now()}-accepted`;
    const response = await putThroughGrant(key, pngFixture(400, 400));
    expect(response.status).toBe(200);

    await driver().delete(key);
  });

  it('refuses an upload whose content type differs from the one that was signed', async () => {
    // `content-type` is among the SIGNED headers, which is what makes it a
    // commitment rather than a hint: a client cannot be granted permission to
    // upload a PNG and then store something else under that key.
    const key = `public/portfolio/${Date.now()}-wrong-type`;
    const target = await driver().createUploadTarget({
      objectKey: key,
      contentType: 'image/png',
      declaredByteSize: 128,
      expiresInSeconds: 120,
      accessClass: 'public',
    });

    const response = await fetch(target.url, {
      method: 'PUT',
      body: pngFixture(400, 400),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(response.status).toBe(403);
  });

  it('refuses an upload target that has expired', async () => {
    const url = presignS3Url(signerConfig, {
      method: 'PUT',
      objectKey: `public/portfolio/${Date.now()}-expired`,
      expiresInSeconds: 1,
      signedHeaders: { 'content-type': 'image/png' },
      // Signed as of two minutes ago, so the one-second window is long gone.
      now: new Date(Date.now() - 120_000),
    });

    const response = await fetch(url, {
      method: 'PUT',
      body: pngFixture(400, 400),
      headers: { 'content-type': 'image/png' },
    });
    expect(response.status).toBe(403);
  });

  it('cannot be repointed at another key by editing the URL', async () => {
    // The property the whole grant model rests on: a target authorizes ONE
    // object. Rewriting the path in a browser's dev tools must not produce an
    // arbitrary-write primitive -- the path is part of what was signed.
    const key = `public/portfolio/${Date.now()}-scoped`;
    const target = await driver().createUploadTarget({
      objectKey: key,
      contentType: 'image/png',
      declaredByteSize: 128,
      expiresInSeconds: 120,
      accessClass: 'public',
    });

    const repointed = target.url.replace(encodeURIComponent(key).replace(/%2F/g, '/'), 'public/portfolio/somebody-else');
    const response = await fetch(repointed, {
      method: 'PUT',
      body: pngFixture(400, 400),
      headers: { 'content-type': 'image/png' },
    });
    expect(response.status).toBe(403);
  });

  it('heads an object and reports its real size and stored content type', async () => {
    const key = `public/portfolio/${Date.now()}-head`;
    const bytes = pngFixture(400, 400);
    expect((await putThroughGrant(key, bytes)).status).toBe(200);

    const head = await driver().head(key);
    expect(head.exists).toBe(true);
    expect(head.byteSize).toBe(bytes.length);
    expect(head.contentType).toBe('image/png');

    await driver().delete(key);
  });

  it('reports a missing object as absent rather than throwing', async () => {
    const head = await driver().head(`public/portfolio/${Date.now()}-never-written`);
    expect(head).toEqual({ exists: false, byteSize: null, contentType: null });
  });

  it('reads a byte RANGE, which is what makes finalize safe on a large object', async () => {
    // Finalize sniffs the header rather than downloading the object. Without a
    // working ranged read it would have to pull whole files into memory on a
    // route any authenticated user can call.
    const key = `public/portfolio/${Date.now()}-range`;
    const bytes = pngFixture(1024, 768, 4096);
    expect((await putThroughGrant(key, bytes)).status).toBe(200);

    const header = await driver().readRange(key, 0, 63);
    expect(header.length).toBe(64);
    expect(header.subarray(0, 8)).toEqual(bytes.subarray(0, 8));

    await driver().delete(key);
  });

  it('round-trips the exact bytes that were uploaded', async () => {
    const key = `public/portfolio/${Date.now()}-roundtrip`;
    const bytes = pngFixture(640, 480);
    expect((await putThroughGrant(key, bytes)).status).toBe(200);

    expect(await driver().read(key)).toEqual(bytes);

    await driver().delete(key);
  });

  it('deletes, and deleting again is a success rather than an error', async () => {
    const key = `public/portfolio/${Date.now()}-delete`;
    expect((await putThroughGrant(key, pngFixture(400, 400))).status).toBe(200);

    await driver().delete(key);
    expect((await driver().head(key)).exists).toBe(false);

    // Idempotent, which the port requires: a rejected upload's cleanup path
    // runs on objects that may or may not exist.
    await expect(driver().delete(key)).resolves.toBeUndefined();
  });

  it('reports itself as durable and produces a public URL when one is configured', async () => {
    const d = driver();
    expect(d.key).toBe('s3');
    // The honesty property `NotificationChannelPort` established: a driver
    // writing to real object storage must be distinguishable from one writing
    // to a container's own disk.
    expect(d.durable).toBe(true);
    expect(d.publicUrl('public/portfolio/x')).toBe(`${ENDPOINT}/${BUCKET}/public/portfolio/x`);
  });

  it('has no public URL when no public base is configured, rather than inventing one', async () => {
    const config = new ConfigService({
      MEDIA_S3_ENDPOINT: ENDPOINT,
      MEDIA_S3_ACCESS_KEY_ID: ACCESS_KEY,
      MEDIA_S3_SECRET_ACCESS_KEY: SECRET_KEY,
      MEDIA_S3_BUCKET: BUCKET,
    });
    // `MediaService` refuses to create a public object at all in this state,
    // rather than handing out a URL that 403s for every visitor.
    expect(new S3ObjectStorageDriver(config).publicUrl('public/portfolio/x')).toBeNull();
  });

  it('refuses to construct without credentials, at boot rather than at first upload', async () => {
    expect(() => new S3ObjectStorageDriver(new ConfigService({ MEDIA_S3_ENDPOINT: ENDPOINT }))).toThrow(
      /MEDIA_S3_ACCESS_KEY_ID is required/,
    );
  });
});
