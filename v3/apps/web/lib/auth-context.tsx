'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClient, ApiRequestError } from './api-client';
import { tokenStorage } from './token-storage';
import { API_BASE_URL } from './config';

export interface AuthenticatedUser {
  id: string;
  phone: string;
  displayName: string | null;
  roles: string[];
  capabilities?: string[];
}

interface VerifyOtpResponse {
  accessToken: string;
  /** Returned for non-browser clients. This app deliberately ignores it -- see below. */
  refreshToken?: string;
  csrfToken: string;
  user: AuthenticatedUser;
}

interface RefreshResponse {
  accessToken: string;
  csrfToken: string;
}

interface AuthContextValue {
  user: AuthenticatedUser | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  requestOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Rotates the session so the next request carries a freshly issued access
   * token — V3.3 #75, `V33-DEC-021` Ruling 9.
   *
   * The seller roles are granted atomically with ownership, but an
   * already-issued JWT is never rewritten: the new role and its capabilities
   * arrive at the NEXT token issuance. A user who has just created their
   * professional profile is holding a token minted seconds before they became a
   * seller, so the seller surfaces would refuse them until the token expired on
   * its own — up to the access-token TTL later.
   *
   * This exposes the refresh the provider already performs on `401`; it is not a
   * new token or session contract, and it stores nothing new. Callers use it
   * immediately after a successful ownership creation and nowhere else.
   *
   * Resolves `false` when the refresh failed. The caller must treat that as "the
   * profile was created but the session is stale", never as "creation failed" —
   * retrying the creation would hit a correct `409`.
   */
  refreshSession: () => Promise<boolean>;
  api: ApiClient;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');

  /**
   * A SEPARATE client for the auth routes, and the only one that sends
   * cookies.
   *
   * Two clients rather than one flag on every call: the credentialed client
   * exists solely for `/v1/auth/refresh` and `/v1/auth/logout`, mirroring the
   * server's `Path=/api/v1/auth` cookie restriction. Every other request in
   * the app is made by a client that cannot send the refresh cookie even by
   * mistake.
   */
  const authApi = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_BASE_URL,
        withCredentials: true,
        getCsrfToken: () => tokenStorage.getCsrfToken(),
      }),
    [],
  );

  /**
   * The in-flight refresh, shared by every concurrent caller.
   *
   * SINGLE-FLIGHT is not an optimisation here -- it is a correctness
   * requirement, and its absence was a real bug. Refresh tokens ROTATE, and
   * the server treats a second presentation of an already-rotated token as a
   * replay and revokes the entire session chain. So two refreshes racing on
   * the same cookie sign the user out: the first rotates successfully, the
   * second presents the token the first just invalidated.
   *
   * That race is not hypothetical. React's StrictMode double-invokes effects
   * in development and reproduced it immediately -- the network log showed
   * `refresh -> 200` followed by `refresh -> 401`, and the user landed back on
   * the sign-in page. The same race occurs in production whenever two API
   * calls 401 at once.
   *
   * A ref rather than state: this must be readable and writable synchronously
   * within one tick, before React would re-render.
   */
  const inFlightRefresh = useRef<Promise<boolean> | null>(null);

  /**
   * Attempts a refresh using the httpOnly cookie.
   *
   * Note there is no token argument and nothing read from storage: the
   * browser supplies the credential, and this code could not read it if it
   * wanted to. That is what makes an XSS unable to steal a 30-day session.
   */
  const refreshSession = useCallback((): Promise<boolean> => {
    if (inFlightRefresh.current) return inFlightRefresh.current;

    const attempt = (async () => {
      try {
        const res = await authApi.post<RefreshResponse>('/v1/auth/refresh', {});
        if (!res.data) return false;
        tokenStorage.set({ accessToken: res.data.accessToken, csrfToken: res.data.csrfToken });
        return true;
      } catch {
        // Revoked, expired, or genuinely replayed. A hard sign-out either way.
        tokenStorage.clear();
        setUser(null);
        setStatus('unauthenticated');
        return false;
      } finally {
        inFlightRefresh.current = null;
      }
    })();

    inFlightRefresh.current = attempt;
    return attempt;
  }, [authApi]);

  // The app-wide client. Carries the access token as a header and never a
  // cookie; `onUnauthorized` wires the refresh in at the transport layer, so
  // no individual caller has to know that access tokens expire.
  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_BASE_URL,
        getAccessToken: () => tokenStorage.getAccessToken(),
        onUnauthorized: refreshSession,
      }),
    [refreshSession],
  );

  /**
   * Session restore on mount.
   *
   * This is the whole user-visible payoff of the cookie work: a page reload
   * starts with no access token, tries a refresh, and the browser presents the
   * cookie. Phase 2's honest limitation -- "a reload signs the user out" -- is
   * closed here, without a long-lived credential ever entering localStorage.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await refreshSession();
      if (cancelled) return;

      if (!restored) {
        setStatus('unauthenticated');
        return;
      }

      try {
        const me = await api.get<AuthenticatedUser>('/v1/me');
        if (cancelled) return;
        setUser(me.data ?? null);
        setStatus('authenticated');
      } catch {
        if (cancelled) return;
        // A valid refresh but an unreadable profile is a broken session, not
        // a signed-in one.
        tokenStorage.clear();
        setStatus('unauthenticated');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, refreshSession]);

  const requestOtp = useCallback(
    async (phone: string) => {
      await api.post('/v1/auth/request-otp', { phone, purpose: 'login' });
    },
    [api],
  );

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      // Through the CREDENTIALED client, so the browser stores the httpOnly
      // refresh cookie the server sets on this response.
      const res = await authApi.post<VerifyOtpResponse>('/v1/auth/verify-otp', {
        phone,
        code,
        purpose: 'login',
      });
      if (!res.data) throw new ApiRequestError('INTERNAL_ERROR', 'پاسخ سرور نامعتبر بود.', 500);

      // `res.data.refreshToken` is deliberately NOT stored. It exists in the
      // response for native clients with no cookie jar; persisting it here
      // would put a 30-day credential back within reach of any script on the
      // page, which is exactly what this design removes.
      tokenStorage.set({ accessToken: res.data.accessToken, csrfToken: res.data.csrfToken });
      setUser(res.data.user);
      setStatus('authenticated');
    },
    [authApi],
  );

  const logout = useCallback(async () => {
    try {
      // Always called, even with no local state: the refresh cookie is
      // httpOnly and ONLY the server's Set-Cookie can clear it. Skipping this
      // would leave a live session on the server.
      await authApi.post('/v1/auth/logout', {});
    } catch {
      // Server-side revocation failing must never strand the user in a
      // half-signed-in state -- clear locally regardless.
    } finally {
      tokenStorage.clear();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [authApi]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, requestOtp, verifyOtp, logout, refreshSession, api }),
    [user, status, requestOtp, verifyOtp, logout, refreshSession, api],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
