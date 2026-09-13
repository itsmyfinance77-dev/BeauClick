'use client';

import { ProGuard } from '@/components/pro-guard';
import { FinanceWorkspaceSurface } from '@/components/finance-workspace';

/**
 * Compatibility entry point -- V3.3 Story #152 (`#149b`).
 *
 * Kept for a professional's existing bookmark/navigation habit. Delegates to
 * the same shared surface the persona-neutral `/finance` route renders, so
 * the two never carry two copies of the finance-rendering logic. A
 * single-professional owner's behaviour is unchanged: exactly one workspace,
 * no selector, opened directly.
 */
export default function ProFinancePage() {
  return <ProGuard>{() => <FinanceWorkspaceSurface />}</ProGuard>;
}
