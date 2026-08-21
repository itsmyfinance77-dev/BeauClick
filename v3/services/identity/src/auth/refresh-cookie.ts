import { CookieOptions, Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * The httpOnly refresh-cookie strategy.
 *
 * Phase 1 named this as Phase 2 scope; Phase 2 disclosed honestly that it had
 * not been done and that a page reload therefore signed the user out. This
 * closes it.
 *
 * The design, and why each part is the way it is:
 *
 * **The refresh token lives in an httpOnly cookie, never in localStorage.**
 * localStorage is readable by any script on the origin, so a single XSS gives
 * an attacker a 30-day credential they can exfiltrate and use from their own
 * machine. httpOnly means the same XSS can make requests AS the user but
 * cannot steal the token itself — the damage is bounded by the session
 * instead of surviving it.
 *
 * **The access token stays in memory.** Deliberately NOT a cookie. An access
 * token in a cookie is sent automatically on every request to the origin,
 * which is exactly what makes CSRF possible; kept in memory and sent as an
 * explicit `Authorization` header, a cross-site request cannot carry it at
 * all. So the two tokens have opposite storage for opposite reasons: the
 * refresh token must survive a reload and must not be script-readable, while
 * the access token must not be sent ambiently.
 *
 * **Path is scoped to the auth routes.** The cookie is only ever needed by
 * `/api/v1/auth/refresh` and `/api/v1/auth/logout`, so it is not attached to
 * any other request. Every request that does not need a credential is a
 * request that cannot leak one.
 *
 * **CSRF: double-submit, because SameSite alone is not enough.** SameSite=Lax
 * blocks cross-SITE requests but treats `api.beauclick.ir` and
 * `beauclick.ir` as the same site — so a subdomain compromise, or any future
 * same-site origin, would defeat it alone. The refresh endpoint is a
 * cookie-authenticated state-changing route that rotates a credential, which
 * is precisely the shape CSRF targets. So a second, non-httpOnly cookie
 * carries a random token that the client must echo in a header; a
 * cross-origin attacker can cause the cookie to be SENT but cannot READ it to
 * populate the header, and cannot set the header cross-origin without CORS
 * approval.
 */

export const REFRESH_COOKIE_NAME = 'bc_refresh';
export const CSRF_COOKIE_NAME = 'bc_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Everything below `/api/v1/auth` — refresh and logout. Nothing else sees the cookie. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieSettings {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  domain?: string;
  maxAgeMs: number;
}

export function cookieSettingsFromEnv(env: NodeJS.ProcessEnv): CookieSettings {
  const isProduction = env.NODE_ENV === 'production';
  const sameSite = (env.AUTH_COOKIE_SAMESITE as CookieSettings['sameSite']) ?? 'lax';

  // `SameSite=None` without `Secure` is rejected outright by every modern
  // browser, so the cookie would silently never be set — the auth system
  // would appear to work in development and fail in production for a reason
  // no log line would explain. Refusing to boot is the honest failure.
  if (sameSite === 'none' && !isProduction && env.AUTH_COOKIE_SECURE !== 'true') {
    throw new Error(
      'AUTH_COOKIE_SAMESITE=none requires AUTH_COOKIE_SECURE=true. A SameSite=None cookie without Secure is dropped by the browser.',
    );
  }

  return {
    // Always Secure in production. Never negotiable: an httpOnly cookie sent
    // over plain HTTP is readable by anything on the path between.
    secure: isProduction || env.AUTH_COOKIE_SECURE === 'true',
    sameSite,
    domain: env.AUTH_COOKIE_DOMAIN || undefined,
    maxAgeMs: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000,
  };
}

function baseOptions(settings: CookieSettings): CookieOptions {
  return {
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    maxAge: settings.maxAgeMs,
  };
}

export function setRefreshCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(settings),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
  });
}

/**
 * Issues a CSRF token, returning it so the caller can also hand it back in the
 * response body.
 *
 * Returned in the body as well as set as a cookie so a client can hold it in
 * memory rather than reading `document.cookie` on every request — but the
 * cookie is what the server actually compares against, so a client that lost
 * the in-memory copy after a reload can still recover it.
 */
export function issueCsrfToken(res: Response, settings: CookieSettings): string {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE_NAME, token, {
    ...baseOptions(settings),
    // NOT httpOnly, on purpose and by necessity: the whole double-submit
    // mechanism depends on the legitimate first-party client being able to
    // read this value and echo it in a header. That is safe precisely because
    // the token is worthless on its own — it authenticates nothing, it only
    // proves the caller can read same-origin cookies.
    httpOnly: false,
    path: REFRESH_COOKIE_PATH,
  });
  return token;
}

export function clearAuthCookies(res: Response, settings: CookieSettings): void {
  // Cleared with the SAME path and domain they were set with. A clear with
  // mismatched attributes silently does nothing, leaving a logged-out user
  // holding a live refresh cookie.
  const options = { path: REFRESH_COOKIE_PATH, domain: settings.domain, secure: settings.secure, sameSite: settings.sameSite };
  res.clearCookie(REFRESH_COOKIE_NAME, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE_NAME, { ...options, httpOnly: false });
}

export function readRefreshCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE_NAME] ?? null;
}

/**
 * Validates the double-submit pair.
 *
 * Compared with `timingSafeEqual` rather than `===`. A plain comparison
 * returns as soon as it finds a differing byte, so the time it takes reveals
 * how many leading characters matched — enough, over many requests, to
 * reconstruct the token one character at a time. The same reasoning the OTP
 * service already applies to code comparison.
 *
 * Length is checked first because `timingSafeEqual` throws on mismatched
 * buffer lengths; hashing both sides to a fixed width instead means the
 * comparison itself is always constant-time regardless of input length.
 */
export function csrfTokenMatches(cookieToken: string | null | undefined, headerToken: string | null | undefined): boolean {
  if (!cookieToken || !headerToken) return false;

  const a = createHash('sha256').update(cookieToken).digest();
  const b = createHash('sha256').update(headerToken).digest();
  return timingSafeEqual(a, b);
}

export function readCsrfHeader(req: Request): string | null {
  const value = req.headers[CSRF_HEADER_NAME];
  return typeof value === 'string' ? value : null;
}

export function readCsrfCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[CSRF_COOKIE_NAME] ?? null;
}
