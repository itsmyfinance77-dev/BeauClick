'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { ProtectedRoute } from '@/components/protected-route';
import { AdminShell } from '@/components/admin-shell';
import { AdminAreaGuard, AdminRouteGate } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';

/**
 * The `/admin` route group.
 *
 * A route group inside `apps/web`, not a second Next.js application -- the same
 * decision and the same reasoning as `/pro`: one design system, one
 * auth/refresh implementation, one deploy, and the real authorization is
 * server-side on every request regardless of which bundle asked.
 *
 * `V3_FRONTEND_ARCHITECTURE.md` §10 left `apps/admin` as an open question;
 * `V3.1_PRODUCT_ROADMAP.md` §8 settles it this way and says to revisit only if
 * admin grows past roughly fifteen screens. It is eight.
 *
 * The guard wraps the SHELL as well as the children, so a user without the
 * capability never sees admin navigation offering routes they cannot open.
 *
 * #264 (`52_MODERATOR_LANDING.md`): one shell, two readings. A caller holding
 * `bc_manage_platform` gets the shell exactly as before; a caller holding only
 * moderation capabilities gets it in its moderation reading — the landing and
 * their own queues — and `AdminRouteGate` refuses every other route inside it.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <LiveCapabilities />
      <AdminAreaGuard>
        <AdminShell>
          <AdminRouteGate>{children}</AdminRouteGate>
        </AdminShell>
      </AdminAreaGuard>
    </ProtectedRoute>
  );
}

/**
 * Re-reads `/v1/me` on every navigation into and within `/admin` — `51` §2.4.
 *
 * The capabilities the shell decides from are live on the server, but the
 * copy in memory is only as fresh as the last read, and a session that signed
 * in hours ago and navigates here client-side would otherwise be offered what
 * it held hours ago. Mounted only once the session is authenticated (it sits
 * inside `ProtectedRoute`), so on a hard load it repeats the restore's own
 * read once — one request, for a rule with no exceptions. Renders nothing;
 * the result arrives through `useAuth().user`, and only if something changed.
 */
function LiveCapabilities() {
  const { status, reloadUser } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'authenticated') void reloadUser();
  }, [status, pathname, reloadUser]);

  return null;
}
