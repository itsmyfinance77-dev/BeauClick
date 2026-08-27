'use client';

import type { ReactNode } from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { AdminShell } from '@/components/admin-shell';
import { AdminGuard } from '@/components/admin-guard';

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
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <AdminGuard>
        <AdminShell>{children}</AdminShell>
      </AdminGuard>
    </ProtectedRoute>
  );
}
