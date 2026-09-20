'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from './kit';
import { useProProfile } from '@/lib/pro-context';
import type { MyProviderProfile } from '@/lib/pro-api';
import styles from './pro-shell.module.css';

/**
 * The professional's shell — `Prototype - Pro and Admin.dc.html` §01 and
 * `V3_INFORMATION_ARCHITECTURE.md` §3.
 *
 * ## From a horizontal band to a fixed column
 *
 * The context band was the right IDEA in the wrong shape. It named the mode,
 * showed who you were operating as and offered the way out — and it carried
 * eight destinations in a row that does not hold eight. The information
 * architecture is explicit: "navigation moves from `pro-shell.tsx`'s
 * seven-item horizontal bar to a FIXED SIDE COLUMN, because seven do not fit
 * a horizontal bar and break on mobile; in a column all seven are always
 * visible and there is room for a counter."
 *
 * Everything the band did, the column's head still does: identity,
 * verification status, and the exit. `ContextBand` stays in the kit for the
 * admin and business surfaces, which have not moved yet.
 *
 * The shell still sits INSIDE `AppShell` rather than replacing it: a separate
 * chrome would mean a second header, a second skip-link target and a second
 * place for the notification badge to drift out of sync.
 *
 * Below 1024 the column becomes a horizontal scroller. The design puts it in
 * a drawer; a scroller keeps every destination reachable and is honest about
 * there being more, and the drawer is recorded rather than half-built.
 */

/**
 * `separator: true` marks where the design's rule falls — the daily work
 * above it, the occasional destinations below.
 */
const PRO_NAV: { href: string; label: string; separatorBefore?: boolean }[] = [
  // Renamed per the information architecture: this page is today's work,
  // and «نمای کلی» described a summary it is not.
  { href: '/pro', label: 'امروز' },
  { href: '/pro/bookings', label: 'رزروها' },
  { href: '/pro/availability', label: 'زمان‌های آزاد' },
  { href: '/pro/services', label: 'خدمات' },
  { href: '/pro/finance', label: 'مالی' },
  { href: '/pro/analytics', label: 'آمار' },
  // V3.3 `#42b` / #159. Beside «مالی» rather than inside it: the terms
  // decide what a cancellation COSTS, which is an operating decision the
  // seller makes once, not a figure they read.
  { href: '/pro/outcome-policy', label: 'شرایط لغو' },
  { href: '/pro/profile', label: 'پروفایل عمومی', separatorBefore: true },
  { href: '/business', label: 'کسب‌وکار' },
];

/** `/pro` matches only itself; every other destination owns its subtree. */
function isCurrent(pathname: string, href: string): boolean {
  return href === '/pro' ? pathname === '/pro' : pathname === href || pathname.startsWith(`${href}/`);
}

const VERIFICATION_LABELS: Record<MyProviderProfile['verificationStatus'], string> = {
  unverified: 'تأیید نشده',
  pending: 'در انتظار بررسی',
  verified: 'تأیید شده',
  rejected: 'رد شده',
  suspended: 'معلق',
  revoked: 'باطل شده',
};

const VERIFICATION_TONE = {
  unverified: 'neutral',
  pending: 'warning',
  verified: 'success',
  rejected: 'error',
  suspended: 'warning',
  revoked: 'error',
} as const;

/**
 * The professional's real verification status.
 *
 * When Task 1 wrote this, no route anywhere in V3 moved a professional past
 * `unverified`, so the badge deliberately carried no call to action -- showing
 * a true status is correct, implying the user can act on one they cannot is
 * not. Phase A closed that gap (`R31-02`): `/pro/profile` now offers a real
 * submission and this badge tracks a status that actually moves.
 */
export function VerificationBadge({ status }: { status: MyProviderProfile['verificationStatus'] }) {
  return <Badge tone={VERIFICATION_TONE[status]}>{VERIFICATION_LABELS[status]}</Badge>;
}

export function ProShell({ children }: { children: ReactNode }) {
  const { profile, state } = useProProfile();
  const pathname = usePathname() ?? '/pro';
  const ready = state === 'ready' && profile;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.identity}>
          <Link href="/pro" className={styles.brand}>
            {/* The static brand mark from `public/`. */}
            <img src="/brand/icon-circle.svg" alt="" width={24} height={24} style={{ borderRadius: 999 }} />
            <span className={styles.brandName}>BeauClick</span>
          </Link>
          {ready ? (
            <div className={styles.who} data-testid="pro-identity">
              <span className={styles.avatar} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <div className={styles.whoName}>{profile.displayName}</div>
                <VerificationBadge status={profile.verificationStatus} />
              </div>
            </div>
          ) : null}
        </div>

        <nav aria-label="ناوبری متخصص" className={styles.nav}>
          {PRO_NAV.map((item) => (
            <span key={item.href} style={{ display: 'contents' }}>
              {item.separatorBefore ? <span className={styles.separator} aria-hidden="true" /> : null}
              <Link
                href={item.href}
                className={styles.link}
                aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
                data-pro-nav={item.href}
              >
                {item.label}
              </Link>
            </span>
          ))}
        </nav>

        <Link href="/" className={styles.exit}>
          <span className={styles.exitChevron} aria-hidden="true" />
          بازگشت به نمای مشتری
        </Link>
      </aside>

      <div className={styles.content}>{children}</div>
    </div>
  );
}
