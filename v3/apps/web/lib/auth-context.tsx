'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  refreshToken: string;
  user: AuthenticatedUser;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface AuthContextValue {
  user: AuthenticatedUser | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  requestOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  api: ApiClient;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');

  // A single ApiClient for the whole app. onUnauthorized wires the refresh
  // flow in at the transport layer, so no individual caller has to know
  // that access tokens expire.
  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_BASE_URL,
        getAccessToken: () => tokenStorage.getAccessToken(),
        onUnauthorized: async () => {
          const refresh = tokenStorage.getRefreshToken();
          if (!refresh) return false;
          try {
            // Deliberately a bare client (no getAccessToken/onUnauthorized):
            // the refresh call must not recurse into this same handler.
            const bare = new ApiClient({ baseUrl: API_BASE_URL });
            const res = await bare.post<RefreshResponse>('/v1/auth/refresh', { refreshToken: refresh });
            if (!res.data) return false;
            tokenStorage.set({ accessToken: res.data.accessToken, refreshToken: res.data.refreshToken });
            return true;
          } catch {
            // Refresh failed (revoked, expired, or replayed -- the server
            // revokes the whole chain on replay). Treat as a hard sign-out.
            tokenStorage.clear();
            setUser(null);
            setStatus('unauthenticated');
            return false;
          }
        },
      }),
    [],
  );

  useEffect(() => {
    // Tokens are in-memory only (see token-storage.ts), so a fresh page load
    // always starts unauthenticated. Stated explicitly rather than left as
    // an accident of implementation.
    setStatus(tokenStorage.isAuthenticated() ? 'authenticated' : 'unauthenticated');
  }, []);

  const requestOtp = useCallback(
    async (phone: string) => {
      await api.post('/v1/auth/request-otp', { phone, purpose: 'login' });
    },
    [api],
  );

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      const res = await api.post<VerifyOtpResponse>('/v1/auth/verify-otp', { phone, code, purpose: 'login' });
      if (!res.data) throw new ApiRequestError('INTERNAL_ERROR', 'پاسخ سرور نامعتبر بود.', 500);
      tokenStorage.set({ accessToken: res.data.accessToken, refreshToken: res.data.refreshToken });
      setUser(res.data.user);
      setStatus('authenticated');
    },
    [api],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStorage.getRefreshToken();
    try {
      if (refreshToken) await api.post('/v1/auth/logout', { refreshToken });
    } catch {
      // Server-side revocation failing must never strand the user in a
      // half-signed-in state -- clear locally regardless.
    } finally {
      tokenStorage.clear();
      setUser(null);
      setStatus('unauthenticated');
    }
  }, [api]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, requestOtp, verifyOtp, logout, api }),
    [user, status, requestOtp, verifyOtp, logout, api],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
