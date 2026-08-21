'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth-context';
import { unreadCount as fetchUnreadCount } from './phase3-api';

interface UnreadContextValue {
  unreadCount: number;
  /** Replaces the count with a figure the server just returned. */
  setUnreadCount: (count: number) => void;
  /** Re-reads the count from the server. */
  refresh: () => Promise<void>;
}

const UnreadContext = createContext<UnreadContextValue | null>(null);

/**
 * The notification badge count, shared between the header and the
 * notification centre.
 *
 * This exists because the two genuinely share one piece of state, and without
 * it they drift: the header fetched the count once on mount, so pressing
 * "mark all as read" cleared the list while the badge kept showing the old
 * number until a full page load. Caught by clicking the real control in a real
 * browser and reading the header afterwards.
 *
 * The page pushes the server's OWN post-action count in rather than
 * decrementing locally -- the server already returns it, and trusting a
 * client-side subtraction is how a badge ends up disagreeing with the list it
 * describes.
 */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const { status, api } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (status !== 'authenticated') {
      setUnreadCount(0);
      return;
    }
    try {
      const res = await fetchUnreadCount(api);
      setUnreadCount(res.data?.unreadCount ?? 0);
    } catch {
      // A badge that cannot load must never break the page it sits on.
    }
  }, [status, api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<UnreadContextValue>(
    () => ({ unreadCount, setUnreadCount, refresh }),
    [unreadCount, refresh],
  );

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export function useUnread(): UnreadContextValue {
  const ctx = useContext(UnreadContext);
  if (!ctx) throw new Error('useUnread must be used inside <UnreadProvider>');
  return ctx;
}
