'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { isSellerSession } from '@/lib/seller-identity';
import { ProShell } from './pro-shell';

/**
 * Chooses the chrome for a page that serves both a seller and everyone else —
 * `/business`, which `PRO_NAV` advertises as a professional destination while
 * the footer and the customer header also open it (#281).
 *
 * A seller gets the professional column (and, below 640, its sheet); anyone
 * else gets the page exactly as before, inside the customer `AppShell` that
 * every route already has. `ProShell` was always built to sit inside that
 * shell, so this adds a frame rather than swapping one.
 *
 * ## Who is a seller
 *
 * `isSellerSession` — the same predicate the customer header uses for its
 * «حالت متخصص» entry, read from the session's live `/v1/me` roles. It was chosen
 * over the professional-profile read (`ProProvider`) because the role arrives
 * WITH the session: no second request, and nothing to wait for. The two cannot
 * disagree for a real seller — the role is granted in the same transaction as
 * the profile row — and where they could (a role without a readable profile)
 * `ProShell` already renders its column without the identity head.
 *
 * ## While identity is unknown
 *
 * The page renders bare: no column, no customer-only decoration. That is
 * deliberate on both counts. Committing to the professional frame early would
 * flash a column at a visitor who is not a seller, and holding the page back
 * would block it on a read it needs anyway — `/business` wraps itself in
 * `ProtectedRoute`, which shows only a loading state until the session
 * settles, and roles are set before that status flips. So the interval in which
 * identity is unknown is exactly the interval in which the page shows a
 * spinner, and the frame appears with the content, not after it.
 */
export function SellerFrame({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status !== 'authenticated' || !isSellerSession(user)) return <>{children}</>;

  return (
    <ProProvider>
      <ProShell>{children}</ProShell>
    </ProProvider>
  );
}
