'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LoadingState } from './ui';
import { EmptyState, TextLink } from './kit';
import { useAuth } from '@/lib/auth-context';
import { adminMode, isModerationRoute } from '@/lib/admin-access';

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
  const holds = user?.capabilities?.includes(capability) ?? false;

  /*
    #264, `51_WORKSPACE_SHELL_AND_DASHBOARDS.md` §2.4. A capability this page
    was rendered WITH and has since lost -- `/v1/me` is re-read after any admin
    403 -- is a different situation from never having held it, and says so.
    Unmounting the children is what clears the page's data: nothing fetched
    before the refusal stays on screen.
  */
  const [hadCapability, setHadCapability] = useState(false);
  useEffect(() => {
    if (holds) setHadCapability(true);
  }, [holds]);

  if (status === 'loading') return <LoadingState label="در حال بررسی دسترسی…" />;

  if (status === 'unauthenticated') {
    return (
      <EmptyState
        message="برای دسترسی به پنل مدیریت باید وارد حساب کاربری خود شوید."
        action={<TextLink href="/auth">ورود</TextLink>}
      />
    );
  }

  if (!holds) {
    if (hadCapability) return <CapabilityRevoked />;
    return <NoAdminAccess />;
  }

  return <>{children}</>;
}

/** The existing no-access state, unchanged in wording — shared by both guards. */
function NoAdminAccess() {
  return (
    <EmptyState
      message="حساب شما دسترسی لازم برای این بخش را ندارد. اگر فکر می‌کنید اشتباهی رخ داده، با مدیر پلتفرم تماس بگیرید."
      action={<TextLink href="/">بازگشت به صفحه اصلی</TextLink>}
    />
  );
}

/** §2.4's capability-revoked state: one sentence and one way back, no retry. */
function CapabilityRevoked() {
  return (
    <EmptyState
      message="دسترسی شما به این بخش تغییر کرده است."
      action={<TextLink href="/admin">بازگشت</TextLink>}
    />
  );
}

/**
 * The guard on the whole `/admin` shell — #264, `52_MODERATOR_LANDING.md` §2.
 *
 * Before #264 the layout wrapped everything in `AdminGuard` with
 * `bc_manage_platform`, so a pure moderator was refused by the shell before any
 * queue could render. Now the shell admits:
 *
 *  - `bc_manage_platform` (operator, administrator), exactly as before;
 *  - one or more `bc_moderate_*` without it — the shell in its moderation
 *    reading, with `AdminRouteGate` below limiting what renders inside it.
 *
 * Anybody else, including a moderator whose last moderation capability was just
 * revoked, gets the existing no-access state and no shell.
 *
 * Still a UX guard and not the boundary, for the reason `AdminGuard` gives.
 */
export function AdminAreaGuard({ children }: { children: ReactNode }) {
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

  if (adminMode(user?.capabilities) === null) return <NoAdminAccess />;
  return <>{children}</>;
}

/**
 * What renders INSIDE the shell for a moderation-only caller: the landing and
 * the four queue routes, and nothing else. Every other `/admin` route — users,
 * audit log, settlements, privacy, search, notifications, phone conflicts,
 * loyalty, every `/admin/commercial/*` page — shows the no-access state here,
 * before its page component mounts or fetches, so a typed URL never gets as
 * far as asking the API. Each of those pages ALSO carries its own guard, and
 * each queue page still checks its own capability, so a partial moderator
 * typing another queue's URL is refused by that page.
 *
 * For `bc_manage_platform` it is a pass-through: nothing changes for an
 * operator or administrator.
 */
export function AdminRouteGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname() ?? '/admin';
  if (adminMode(user?.capabilities) === 'moderation' && !isModerationRoute(pathname)) return <NoAdminAccess />;
  return <>{children}</>;
}
