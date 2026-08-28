import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour.
 *
 * WHY THIS IS HAND-WRITTEN rather than pulled from `@aws-sdk/*`.
 *
 * The dependency would be ~15 MB of transitive packages, and every one of
 * them ships in an image whose hosting region is the open question this
 * whole phase is gated on (`V3.1_PRODUCT_ROADMAP.md` §12 #1). What is
 * actually needed is one signing function, and SigV4 query authentication
 * is a fully specified, stable algorithm -- not a moving target.
 *
 * The honest risk of hand-writing a signing algorithm is that it looks right
 * and is wrong, which is why this is NOT verified by unit-testing its
 * intermediate strings against values this file itself produced. It is
 * verified end to end against a real S3-compatible server (MinIO) in
 * `media-s3.pg-spec.ts` and in CI: a signature this file computes is
 * accepted, or the object never lands and the test fails. A wrong signature
 * cannot pass that.
 *
 * ONE DELIBERATE OMISSION, stated because it is load-bearing for the media
 * security model: `content-length` is NOT among the signed headers. Signing
 * it would let the store itself reject an upload larger than the client
 * declared, which is strictly better -- but support for a signed
 * `content-length` on a presigned PUT varies across S3-compatible vendors,
 * and the vendor is exactly what has not been chosen yet. The size cap is
 * therefore enforced where it is enforceable against every driver: at
 * finalize, server-side, against the size the STORE reports, with the object
 * deleted when it exceeds the cap. See `MediaService.finalize`.
 */

export interface SigV4Config {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Origin only, no trailing slash: `https://s3.example.com` or `http://127.0.0.1:9000`. */
  endpoint: string;
  bucket: string;
  /**
   * Path-style (`https://host/bucket/key`) vs virtual-host-style
   * (`https://bucket.host/key`). Path-style is the default because it is
   * what every self-hosted and most Iranian S3-compatible endpoints serve,
   * and because it works without wildcard DNS.
   */
  forcePathStyle: boolean;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** RFC 3986 unreserved set, which is narrower than `encodeURIComponent`'s. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(char);
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || '-_.~'.includes(c)) {
      out += c;
    } else if (c === '/' && !encodeSlash) {
      out += '/';
    } else {
      out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function amzDate(now: Date): { stamp: string; date: string } {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { stamp, date: stamp.slice(0, 8) };
}

export interface PresignRequest {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  objectKey: string;
  expiresInSeconds: number;
  /**
   * Headers to sign beyond `host`, lower-cased.
   *
   * Whatever is here MUST be sent verbatim by the caller or the store
   * rejects the request -- that is the point: a signed `content-type` is a
   * content type the uploader cannot change after the grant was issued.
   */
  signedHeaders?: Record<string, string>;
  now?: Date;
}

export function presignS3Url(config: SigV4Config, request: PresignRequest): string {
  const now = request.now ?? new Date();
  const { stamp, date } = amzDate(now);
  const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;

  const endpoint = new URL(config.endpoint);
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = config.forcePathStyle
    ? `/${uriEncode(config.bucket)}/${uriEncode(request.objectKey, false)}`
    : `/${uriEncode(request.objectKey, false)}`;

  // Lower-cased once, up front: the canonical header block, the
  // SignedHeaders list, and the query parameter must all agree on the same
  // spelling, and reconciling three casings later is how this goes wrong.
  const headers = new Map<string, string>([['host', host]]);
  for (const [name, value] of Object.entries(request.signedHeaders ?? {})) {
    headers.set(name.toLowerCase(), value);
  }
  const headerNames = [...headers.keys()].sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${(headers.get(name) ?? '').trim()}\n`).join('');
  const signedHeaderList = headerNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(request.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  const canonicalRequest = [
    request.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    // The payload hash is unknown at signing time for a browser-driven PUT,
    // which is exactly what this literal is defined for.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, date), config.region), SERVICE), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
