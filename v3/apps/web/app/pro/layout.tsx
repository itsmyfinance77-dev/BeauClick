'use client';

import type { ReactNode } from 'react';
import { ProtectedRoute } from '@/components/protected-route';
import { ProShell } from '@/components/pro-shell';
import { ProProvider } from '@/lib/pro-context';

/**
 * The `/pro` route group.
 *
 * A route group inside `apps/web`, not a second Next.js application — per this
 * task's brief and `V3.1_PRODUCT_ROADMAP.md` §8's reasoning: one design
 * system, one auth/refresh implementation, one deploy, and the real
 * authorization is server-side on every request regardless.
 *
 * `ProtectedRoute` here is a UX guard, not a security boundary (see its own
 * docblock). Nothing under `/pro` is protected by this component; it is
 * protected by `JwtAuthGuard` + `OwnershipGuard` re-verifying every single
 * request. A user who bypasses this sees empty screens, never data.
 */
export default function ProLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <ProProvider>
        <ProShell>{children}</ProShell>
      </ProProvider>
    </ProtectedRoute>
  );
}
