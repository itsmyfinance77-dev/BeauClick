'use client';

import { ProtectedRoute } from '@/components/protected-route';
import { FinanceWorkspaceSurface } from '@/components/finance-workspace';

/**
 * The persona-neutral finance destination -- V3.3 Story #152 (`#149b`).
 *
 * Deliberately `ProtectedRoute` only: no `ProProvider`, no `ProGuard`, no
 * `ProShell`, and no professional-profile requirement of any kind. A business
 * owner with no professional profile, a dual owner, and a finance-only staff
 * member holding a live `finance_read` grant all reach their finance
 * workspace(s) from here without ever being asked to create a professional
 * profile or being called "متخصص" anywhere on the screen.
 *
 * Renders the same shared surface `/pro/finance` delegates to, so the two
 * routes can never carry two different finance-rendering implementations.
 */
export default function FinancePage() {
  return (
    <ProtectedRoute>
      <FinanceWorkspaceSurface />
    </ProtectedRoute>
  );
}
