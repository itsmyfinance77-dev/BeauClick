import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed, self-describing upload token the LOCAL driver hands out.
 *
 * The S3 driver has no equivalent because S3 already has one -- SigV4 query
 * authentication IS this, standardized. This exists so the local driver's
 * upload URL carries the same three properties a presigned S3 URL carries,
 * rather than being a weaker stand-in that passes tests the real driver
 * would fail:
 *
 *   - it authorizes exactly ONE object key,
 *   - it pins the content type and the exact byte count,
 *   - it expires.
 *
 * Deliberately stateless. A pending-upload row already exists in
 * `media.objects`, and the PUT route re-reads it; the token is the
 * unguessable capability (`V3_SECURITY_MODEL.md` §8) and the row is the
 * authorization state. Two independent facts, both required -- a stolen
 * token for an already-finalized or deleted object writes nothing.
 */

export interface UploadTokenClaims {
  /** The one object key this token may write. */
  k: string;
  /** Media row id, so the PUT route can re-check the row's state without parsing the key. */
  m: string;
  /** Content type the client committed to. */
  c: string;
  /** Exact declared size in bytes. */
  n: number;
  /** Expiry, epoch seconds. */
  e: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signUploadToken(claims: UploadTokenClaims, secret: string): string {
  const body = b64url(JSON.stringify(claims));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export class InvalidUploadTokenError extends Error {}

/**
 * Verifies and decodes. Throws `InvalidUploadTokenError` for every failure
 * mode with the SAME message: a caller cannot learn whether a token was
 * malformed, forged, or merely expired, because that distinction is only
 * useful to somebody probing.
 */
export function verifyUploadToken(token: string, secret: string, nowMs: number): UploadTokenClaims {
  const invalid = (): never => {
    throw new InvalidUploadTokenError('invalid upload token');
  };

  const parts = token.split('.');
  if (parts.length !== 2) invalid();
  const [body, mac] = parts;

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const given = Buffer.from(mac, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // Length check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, so an attacker could otherwise distinguish
  // "wrong length" from "wrong bytes" by the error that came back.
  if (given.length !== want.length || !timingSafeEqual(given, want)) invalid();

  let claims: UploadTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadTokenClaims;
  } catch {
    return invalid();
  }

  if (typeof claims.k !== 'string' || typeof claims.m !== 'string' || typeof claims.e !== 'number') invalid();
  if (claims.e * 1000 <= nowMs) invalid();

  return claims;
}
