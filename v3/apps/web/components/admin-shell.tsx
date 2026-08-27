'use client';

import type { ReactNode } from 'react';
import { Badge, ContextBand, NavLink } from './kit';
import { useAuth } from '@/lib/auth-context';

/**
 * The admin context bar.
 *
 * Deliberately the same PATTERN as `ProShell` and deliberately a different
 * COLOUR. Task 1 established that a role context is a tinted band under the app
 * header carrying a mode badge, who you are acting as, the mode's own nav, and
 * a permanent way out.
 *
 * Phase A copied that structure here on the reasoning that "re-deciding it
 * would produce a second convention". True, but copying produced two
 * implementations of one convention, which is the same problem one refactor
 * later -- so Phase G moved the structure into `ContextBand` and left this file
 * holding only what is genuinely admin-specific.
 *
 * The colour is one of those specifics, and it carries meaning rather than
 * decoration. A professional acting in the wrong context edits their own
 * catalogue; an operator acting in the wrong context settles somebody else's
 * money. The band uses the warning token so "you are in the admin panel" is not
 * something the user has to read to know.
 */

const ADMIN_NAV: { href: string; label: string; capability?: string }[] = [
  { href: '/admin', label: 'نمای کلی' },
  { href: '/admin/verification', label: 'احراز هویت', capability: 'bc_moderate_verification' },
  { href: '/admin/users', label: 'کاربران و نقش‌ها' },
  { href: '/admin/audit-log', label: 'گزارش عملیات' },
  { href: '/admin/settlements', label: 'تسویه‌ها' },
  { href: '/admin/search', label: 'جست‌وجو' },
  { href: '/admin/notifications', label: 'اعلان‌ها' },
  { href: '/admin/phone-conflicts', label: 'تعارض شماره' },
  { href: '/admin/loyalty', label: 'باشگاه' },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const capabilities = user?.capabilities ?? [];

  // Hiding a link the operator cannot use is a courtesy, not a control: the
  // API refuses the request regardless of what the nav shows, and the
  // `operability-foundation.pg-spec` suite proves that for every route here.
  const visible = ADMIN_NAV.filter((item) => !item.capability || capabilities.includes(item.capability));

  return (
    <div>
      <ContextBand
        tone="warning"
        modeLabel="پنل مدیریت"
        identity={user?.displayName ?? user?.phone}
        // The operator's real capabilities, shown rather than implied. Someone
        // acting on the platform should be able to see the extent of their own
        // authority without asking anyone.
        status={capabilities
          .filter((c) => c.startsWith('bc_manage_platform') || c.startsWith('bc_moderate'))
          .map((c) => (
            <Badge key={c} tone="neutral">
              {CAPABILITY_LABELS[c] ?? c}
            </Badge>
          ))}
        exitHref="/"
        exitLabel="خروج از پنل مدیریت"
        navLabel="ناوبری مدیریت"
      >
        {visible.map((item) => (
          <NavLink key={item.href} href={item.href} tone="warning" underline>
            {item.label}
          </NavLink>
        ))}
      </ContextBand>

      {children}
    </div>
  );
}

/**
 * Persian labels for the capabilities an operator can hold.
 *
 * Falls back to the raw slug, which QA-22 records as the codebase's standing
 * habit -- acceptable HERE and nowhere user-facing: this band is only ever seen
 * by an operator, for whom `bc_manage_platform` is a meaningful string rather
 * than leaked English. The customer surfaces do not get that latitude.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  bc_manage_platform: 'مدیریت پلتفرم',
  bc_moderate_verification: 'بررسی احراز هویت',
  bc_moderate_reviews: 'بررسی دیدگاه‌ها',
};
