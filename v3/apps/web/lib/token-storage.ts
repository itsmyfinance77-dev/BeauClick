/**
 * Token storage policy for the V3 frontend.
 *
 * The split, and why each half is where it is (ADR-020):
 *
 * - **ACCESS token (15 min): in memory only.** Never localStorage, never a
 *   cookie. Not localStorage because an XSS that can read it can exfiltrate a
 *   credential; not a cookie because a cookie is sent automatically on every
 *   request to the origin, which is exactly what makes CSRF possible. Sent as
 *   an explicit `Authorization` header, it cannot ride along on a
 *   cross-site request at all.
 *
 * - **REFRESH token (30 days): an httpOnly cookie the server sets.** Not held
 *   here at all — this module cannot read it, and neither can any other
 *   script on the page. That is the point.
 *
 * Phase 3 closes the Phase 1/2 limitation this file used to describe: the
 * refresh token was in memory, so a page reload signed the user out. Now a
 * reload finds no access token, calls `/v1/auth/refresh`, and the browser
 * supplies the cookie — the session survives without a long-lived credential
 * ever being readable by JavaScript.
 *
 * The CSRF token IS held here. It is not a credential: it authenticates
 * nothing on its own and only proves the caller can read same-origin cookies.
 * Keeping the in-memory copy avoids parsing `document.cookie` on every
 * request, and it is recoverable from the cookie after a reload.
 */

let accessToken: string | null = null;
let csrfToken: string | null = null;

/** Set by the server alongside the refresh cookie; readable by JS on purpose. */
const CSRF_COOKIE_NAME = 'bc_csrf';

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE_NAME.length + 1)) : null;
}

export const tokenStorage = {
  getAccessToken(): string | null {
    return accessToken;
  },

  /**
   * The in-memory CSRF token, falling back to the cookie.
   *
   * The fallback is what makes a reload work: the in-memory copy is gone, but
   * the cookie survives, so the very first refresh after a reload can still
   * present a matching header.
   */
  getCsrfToken(): string | null {
    return csrfToken ?? readCsrfCookie();
  },

  set(tokens: { accessToken: string; csrfToken?: string | null }): void {
    accessToken = tokens.accessToken;
    if (tokens.csrfToken) csrfToken = tokens.csrfToken;
  },

  clear(): void {
    accessToken = null;
    csrfToken = null;
    // The refresh cookie is httpOnly and CANNOT be cleared from here -- only
    // the server's `Set-Cookie` on logout can remove it. Clearing local state
    // without calling logout would leave a live session on the server, which
    // is why `logout()` always calls the endpoint.
  },

  isAuthenticated(): boolean {
    return accessToken !== null;
  },
};
