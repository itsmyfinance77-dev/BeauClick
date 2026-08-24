'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth-context';
import { myProvider, type MyProviderProfile } from './pro-api';

/**
 * The professional profile, loaded once for the whole `/pro` route group.
 *
 * Every screen under `/pro` needs the caller's own `professionalId` — the
 * profile editor, the service catalogue, and (indirectly) the booking list all
 * address it. Loading it per page would mean five identical requests on a
 * five-screen session and, worse, five independent places to get the
 * failed-load distinction wrong.
 *
 * `state` has FOUR values, not three, and the fourth is the point:
 *
 *   loading   — the request is in flight
 *   error     — the request FAILED. We know nothing.
 *   none      — the server answered: this user has no professional profile
 *   ready     — the server answered with a profile
 *
 * `error` and `none` are what QA-06 and QA-07 conflated across five surfaces
 * before v3.0.1: both leave a null profile, and treating them the same renders
 * a blank "create your profile" form over a profile that already exists. On
 * this surface that would be worse than it was there — submitting it would hit
 * `POST /v1/providers`, which correctly 409s (`ProviderAlreadyExistsException`),
 * so the user would be told they already have a profile they cannot see.
 */

export type ProState = 'loading' | 'error' | 'none' | 'ready';

interface ProContextValue {
  state: ProState;
  profile: MyProviderProfile | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Replaces the cached profile after a successful create/update, so every screen sees it without a refetch. */
  setProfile: (profile: MyProviderProfile) => void;
}

const ProContext = createContext<ProContextValue | null>(null);

export function ProProvider({ children }: { children: ReactNode }) {
  const { api, status } = useAuth();
  const [state, setState] = useState<ProState>('loading');
  const [profile, setProfileState] = useState<MyProviderProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await myProvider(api);
      // `data` is null when the server says "you have no profile". That is an
      // ANSWER, and it is why this branch sets 'none' rather than leaving the
      // caller to infer emptiness from a null.
      if (res.data) {
        setProfileState(res.data);
        setState('ready');
      } else {
        setProfileState(null);
        setState('none');
      }
    } catch (err) {
      setProfileState(null);
      setError(err instanceof Error ? err.message : 'پروفایل متخصص بارگذاری نشد.');
      setState('error');
    }
  }, [api]);

  useEffect(() => {
    // Wait for auth to settle: firing this while the refresh is still in
    // flight produces a spurious 401 and an error state the user did nothing
    // to cause.
    if (status !== 'authenticated') return;
    void reload();
  }, [status, reload]);

  const setProfile = useCallback((next: MyProviderProfile) => {
    setProfileState(next);
    setState('ready');
  }, []);

  const value = useMemo(
    () => ({ state, profile, error, reload, setProfile }),
    [state, profile, error, reload, setProfile],
  );

  return <ProContext.Provider value={value}>{children}</ProContext.Provider>;
}

export function useProProfile(): ProContextValue {
  const ctx = useContext(ProContext);
  if (!ctx) throw new Error('useProProfile must be used inside <ProProvider>');
  return ctx;
}
