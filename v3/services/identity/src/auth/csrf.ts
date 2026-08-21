import { Request } from 'express';
import { CSRF_HEADER_NAME, csrfTokenMatches, readCsrfCookie, readCsrfHeader } from './refresh-cookie';

/**
 * CSRF protection for the cookie-authenticated auth routes.
 *
 * ## Why this is not simply double-submit
 *
 * The first implementation was pure double-submit: a non-httpOnly `bc_csrf`
 * cookie the client reads and echoes in `X-CSRF-Token`. Driving a real browser
 * proved it cannot work in this deployment:
 *
 *   The web app runs on one origin and the API on another. The CSRF cookie is
 *   set by the API, so it belongs to the API's origin -- and `document.cookie`
 *   on the web app's origin cannot see it. The browser dutifully SENDS it with
 *   the refresh request, but the client can never READ it to populate the
 *   header. So after a page reload, with the in-memory copy gone, every
 *   refresh was rejected 403 and the user was signed out -- exactly the
 *   behaviour the httpOnly cookie was introduced to fix.
 *
 * Double-submit assumes a same-origin (or proxied) topology. That assumption
 * was never stated, and it was wrong here.
 *
 * ## What replaces it
 *
 * **Origin validation as the primary defence.** `Origin` is set by the browser
 * on every cross-origin request and on every same-origin state-changing one,
 * and page JavaScript cannot forge it -- that is the whole reason the header
 * exists. A request from `evil.example` carries `Origin: https://evil.example`,
 * which is not in the allow-list, and is refused before it reaches the token.
 * This is a standard, recommended CSRF defence, not a workaround.
 *
 * **Double-submit retained as a second layer where it CAN work.** If the
 * client supplies a token, it must match the cookie. That keeps the protection
 * meaningful for a same-origin/proxied deployment, and means a supplied-but-
 * wrong token is always a rejection rather than something quietly ignored.
 *
 * The two combine so that a request must satisfy BOTH checks it is capable of
 * satisfying -- never so that failing one can be excused by skipping the other.
 */

export type CsrfOutcome =
  | { ok: true }
  | { ok: false; reason: 'origin_not_allowed' | 'origin_missing' | 'token_mismatch' };

export interface CsrfPolicy {
  /** The same allow-list CORS uses. One source of truth for "who may drive this API". */
  allowedOrigins: string[];
}

export function csrfPolicyFromEnv(env: NodeJS.ProcessEnv): CsrfPolicy {
  return {
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3100')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/**
 * Decides whether a cookie-authenticated request may proceed.
 *
 * Called ONLY when the credential came from the cookie. A request presenting
 * the refresh token in its body is not vulnerable to CSRF at all -- a
 * cross-site attacker cannot read the token to put it there -- so applying
 * this to that path would reject legitimate native clients for no benefit.
 */
export function evaluateCsrf(req: Request, policy: CsrfPolicy): CsrfOutcome {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

  // A supplied token must always be correct, whatever the origin says. Checked
  // FIRST so a wrong token is never excused by a trusted origin.
  const cookieToken = readCsrfCookie(req);
  const headerToken = readCsrfHeader(req);
  if (headerToken !== null && !csrfTokenMatches(cookieToken, headerToken)) {
    return { ok: false, reason: 'token_mismatch' };
  }

  if (origin !== null) {
    return policy.allowedOrigins.includes(origin) ? { ok: true } : { ok: false, reason: 'origin_not_allowed' };
  }

  // No Origin header. Two real cases:
  //
  //   * A non-browser client that also sent no cookie -- but then this
  //     function was never called, because the body path is used.
  //   * A same-origin request from a browser that omits Origin on some
  //     navigations.
  //
  // With no origin to check, the double-submit token is the only evidence
  // available, so it becomes REQUIRED rather than optional. This is the one
  // branch where a missing token is fatal.
  if (headerToken === null) return { ok: false, reason: 'origin_missing' };
  return { ok: true };
}

export { CSRF_HEADER_NAME };
