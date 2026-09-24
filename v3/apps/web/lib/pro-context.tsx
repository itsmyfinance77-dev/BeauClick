'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth-context';
import { myProvider, upcomingBookingCount, type MyProviderProfile } from './pro-api';

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
  /**
   * Bookings still ahead of this professional -- #282, the number behind the
   * navigation's «رزروها» badge.
   *
   * `null` is "not known": the read is in flight, or it failed, or this user has
   * no professional profile to count for. It is NOT zero. The same distinction
   * this file's `state` makes for the profile, for the same reason -- a badge
   * reading «۰» because a request failed is a claim nobody made.
   *
   * ONE place this number is computed. The column badge and `/pro/bookings`'s
   * «پیش‌رو» tab label both read it from here rather than each counting for
   * themselves, which is what kept them from disagreeing when the tab counted
   * the page it held and the badge counted everything.
   */
  upcomingBookings: number | null;
  /** Re-reads the count. Called by screens that move a booking into or out of the upcoming set. */
  refreshUpcomingBookings: () => Promise<void>;
}

const ProContext = createContext<ProContextValue | null>(null);

export function ProProvider({ children }: { children: ReactNode }) {
  const { api, status } = useAuth();
  const [state, setState] = useState<ProState>('loading');
  const [profile, setProfileState] = useState<MyProviderProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upcomingBookings, setUpcomingBookings] = useState<number | null>(null);

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

  /**
   * Re-reads the upcoming count -- #282.
   *
   * A failure sets `null` rather than keeping the last number: a stale count is
   * worse than no count, because nothing on screen would say it is stale. The
   * badge simply goes away, and the route beside it still works.
   */
  const refreshUpcomingBookings = useCallback(async () => {
    try {
      const res = await upcomingBookingCount(api);
      setUpcomingBookings(res.data?.upcomingCount ?? null);
    } catch {
      setUpcomingBookings(null);
    }
  }, [api]);

  useEffect(() => {
    /*
     * Only once there IS a professional profile. The route answers 404 for a
     * user without one -- correctly, since a zero would tell them they have no
     * upcoming bookings rather than no professional identity -- and asking
     * anyway would spend a request to learn what `state` already says.
     */
    if (state !== 'ready') {
      setUpcomingBookings(null);
      return;
    }
    void refreshUpcomingBookings();
  }, [state, refreshUpcomingBookings]);

  const value = useMemo(
    () => ({ state, profile, error, reload, setProfile, upcomingBookings, refreshUpcomingBookings }),
    [state, profile, error, reload, setProfile, upcomingBookings, refreshUpcomingBookings],
  );

  return <ProContext.Provider value={value}>{children}</ProContext.Provider>;
}

export function useProProfile(): ProContextValue {
  const ctx = useContext(ProContext);
  if (!ctx) throw new Error('useProProfile must be used inside <ProProvider>');
  return ctx;
}
