'use client';

import type { ReactNode } from 'react';
import { LoadingState } from './ui';
import { EmptyState, TextLink } from './kit';
import { useAuth } from '@/lib/auth-context';

/**
 * Renders its children only for a session that actually holds the capability.
 *
 * **This is a UX guard, not a security boundary**, exactly as
 * `ProtectedRoute`'s own docblock says of itself -- and it matters more here,
 * so it is worth restating rather than assuming the reader knows. Nothing under
 * `/admin` is protected by this component. It is protected by
 * `CapabilityGuard`, which re-checks the capability on every request AND, for
 * privileged capabilities, re-reads the role assignment from the database so a
 * revoked operator is refused even holding a valid token. A user who bypasses
 * this component sees empty screens and 403s, never data.
 *
 * What it does buy: an ordinary customer who lands on `/admin` gets an
 * explanation instead of a page full of failed requests.
 *
 * The capability list comes from `/v1/me`, which resolves LIVE from
 * `identity.user_roles` rather than echoing the token -- so a revocation
 * removes the surface from the UI at the next page load, not at the next token.
 */
export function AdminGuard({
  children,
  capability = 'bc_manage_platform',
}: {
  children: ReactNode;
  capability?: string;
}) {
  const { status, user } = useAuth();

  if (status === 'loading') return <LoadingState label="در حال بررسی دسترسی…" />;

  if (status === 'unauthenticated') {
    return (
      <EmptyState
        message="برای دسترسی به پنل مدیریت باید وارد حساب کاربری خود شوید."
        action={<TextLink href="/auth">ورود</TextLink>}
      />
    );
  }

  if (!user?.capabilities?.includes(capability)) {
    return (
      <EmptyState
        message="حساب شما دسترسی لازم برای این بخش را ندارد. اگر فکر می‌کنید اشتباهی رخ داده، با مدیر پلتفرم تماس بگیرید."
        action={<TextLink href="/">بازگشت به صفحه اصلی</TextLink>}
      />
    );
  }

  return <>{children}</>;
}
