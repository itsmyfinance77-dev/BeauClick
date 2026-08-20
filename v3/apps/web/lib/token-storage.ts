/**
 * Token storage policy for the V3 frontend.
 *
 * V3_API_CONTRACT_BLUEPRINT.md §2 / this phase's frontend-security
 * requirements. The deliberate split, and why:
 *
 * - ACCESS token (15 min): held in memory only. Never localStorage,
 *   never a cookie readable by JS -- an XSS that can read localStorage can
 *   exfiltrate a long-lived credential, and an in-memory token dies with
 *   the tab.
 * - REFRESH token (30 days): also in memory for this Phase 1 foundation,
 *   which means a full page reload signs the user out. That is a
 *   deliberate, disclosed Phase 1 limitation, NOT the final design: the
 *   real answer is an httpOnly, Secure, SameSite=Strict cookie set by the
 *   server, which requires a server-side auth route (a Next.js route
 *   handler proxying identity-service) that is Phase 2 scope. Choosing
 *   "signs out on reload" over "long-lived credential in localStorage" is
 *   the safer of the two options available now.
 *
 * NOTHING secret is ever baked into frontend code or NEXT_PUBLIC_* env
 * vars -- the API base URL is the only configuration the browser needs.
 */

let accessToken: string | null = null;
let refreshToken: string | null = null;

export const tokenStorage = {
  getAccessToken(): string | null {
    return accessToken;
  },
  getRefreshToken(): string | null {
    return refreshToken;
  },
  set(tokens: { accessToken: string; refreshToken: string }): void {
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
  },
  clear(): void {
    accessToken = null;
    refreshToken = null;
  },
  isAuthenticated(): boolean {
    return accessToken !== null;
  },
};
