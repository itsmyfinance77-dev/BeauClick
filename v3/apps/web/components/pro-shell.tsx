'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from './pro-ui';
import { useProProfile } from '@/lib/pro-context';
import type { MyProviderProfile } from '@/lib/pro-api';

/**
 * The professional context bar.
 *
 * The UI/UX audit's §4 finding was that V3 has "no visual distinction between
 * customer, business, and (absent) professional contexts". This surface adds
 * the third context, so it establishes the pattern rather than inheriting one:
 * a tinted band, directly under the app header, that names the mode, shows who
 * you are operating as, carries the mode's own navigation, and always offers
 * the way back out to the customer surfaces.
 *
 * It deliberately sits INSIDE the existing `AppShell` rather than replacing
 * it. A separate chrome would mean a second header, a second nav, a second
 * skip-link target and a second place for the notification badge to drift out
 * of sync — a second design system by accretion, which §4 of this task's brief
 * explicitly forbids.
 */

const PRO_NAV: { href: string; label: string }[] = [
  { href: '/pro', label: 'نمای کلی' },
  { href: '/pro/bookings', label: 'رزروها' },
  { href: '/pro/availability', label: 'زمان‌های آزاد' },
  { href: '/pro/services', label: 'خدمات' },
  { href: '/pro/finance', label: 'مالی' },
  { href: '/pro/analytics', label: 'آمار' },
  { href: '/pro/profile', label: 'پروفایل' },
];

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
 * The verification badge is honest about a real product gap rather than
 * decorative. No route anywhere in V3 moves a professional past `unverified`
 * — `ProviderService.transitionVerification()` exists, is tested, and has no
 * caller outside a spec file — so every professional sees "تأیید نشده"
 * permanently. Showing the true status is correct; implying the user can do
 * something about it would not be, so the badge carries no call to action.
 */
export function VerificationBadge({ status }: { status: MyProviderProfile['verificationStatus'] }) {
  return <Badge tone={VERIFICATION_TONE[status]}>{VERIFICATION_LABELS[status]}</Badge>;
}

function ProNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  // Exact match: '/pro' would otherwise prefix-match every child route and
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
        color: isCurrent ? 'var(--bc-color-primary)' : 'var(--bc-color-ink)',
        // Weight AND colour, never colour alone -- the same reasoning the
        // customer nav's own aria-current fix used in v3.0.1.
        borderBlockEnd: isCurrent ? '2px solid var(--bc-color-primary)' : '2px solid transparent',
      }}
    >
      {label}
    </Link>
  );
}

export function ProShell({ children }: { children: ReactNode }) {
  const { profile, state } = useProProfile();

  return (
    <div>
      <div
        style={{
          background: 'var(--bc-color-primary-soft)',
          border: '1px solid var(--bc-color-line)',
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
            <Badge tone="primary">حالت متخصص</Badge>
            {state === 'ready' && profile ? (
              <>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{profile.displayName}</span>
                <VerificationBadge status={profile.verificationStatus} />
              </>
            ) : null}
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
            بازگشت به نمای مشتری
          </Link>
        </div>

        <nav
          aria-label="ناوبری متخصص"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--bc-spacing-chip-gap)',
            rowGap: 0,
            minWidth: 0,
          }}
        >
          {PRO_NAV.map((item) => (
            <ProNavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
      </div>

      {children}
    </div>
  );
}
