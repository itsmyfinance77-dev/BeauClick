'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from './pro-ui';
import { useAuth } from '@/lib/auth-context';

/**
 * The admin context bar.
 *
 * Deliberately the same PATTERN as `ProShell` and deliberately a different
 * COLOUR. Task 1 established that a role context is a tinted band under the app
 * header carrying a mode badge, who you are acting as, the mode's own nav, and
 * a permanent way out. Re-deciding that here would produce a second convention;
 * copying it produces one convention with two instances.
 *
 * The colour differs because the consequence differs. A professional acting in
 * the wrong context edits their own catalogue; an operator acting in the wrong
 * context settles somebody else's money. The band uses the warning token so
 * "you are in the admin panel" is not something the user has to read to know.
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

function AdminNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  // Exact match: '/admin' would otherwise prefix-match every child route and
  // mark two links current at once.
  const isCurrent = pathname === href;
  return (
    <Link
      href={href}
      aria-current={isCurrent ? 'page' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 44,
        padding: '0 2px',
        fontSize: 14,
        fontWeight: isCurrent ? 800 : 600,
        color: isCurrent ? 'var(--bc-color-warning)' : 'var(--bc-color-ink)',
        // Weight AND colour, never colour alone -- not every reader can make a
        // colour distinction.
        borderBlockEnd: isCurrent ? '2px solid var(--bc-color-warning)' : '2px solid transparent',
      }}
    >
      {label}
    </Link>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const capabilities = user?.capabilities ?? [];

  // Hiding a link the operator cannot use is a courtesy, not a control: the
  // API refuses the request regardless of what the nav shows, and the
  // `operability-foundation.pg-spec` suite proves that for every route here.
  const visible = ADMIN_NAV.filter((item) => !item.capability || capabilities.includes(item.capability));

  return (
    <div>
      <div
        style={{
          background: 'var(--bc-color-warning-soft)',
          border: '1px solid var(--bc-color-warning)',
          borderRadius: 'var(--bc-radius-card)',
          padding: 'clamp(12px, 2vw, 16px)',
          marginBlockEnd: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--bc-spacing-chip-gap)',
            marginBlockEnd: 8,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Badge tone="warning">پنل مدیریت</Badge>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{user?.displayName ?? user?.phone}</span>
            {/* The operator's real capabilities, shown rather than implied.
                Someone acting on the platform should be able to see the extent
                of their own authority without asking anyone. */}
            {capabilities
              .filter((c) => c.startsWith('bc_manage_platform') || c.startsWith('bc_moderate'))
              .map((c) => (
                <Badge key={c} tone="neutral">
                  {CAPABILITY_LABELS[c] ?? c}
                </Badge>
              ))}
          </div>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--bc-color-ink-soft)',
            }}
          >
            خروج از پنل مدیریت
          </Link>
        </div>

        <nav
          aria-label="ناوبری مدیریت"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--bc-spacing-chip-gap)', rowGap: 0, minWidth: 0 }}
        >
          {visible.map((item) => (
            <AdminNavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </div>

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
