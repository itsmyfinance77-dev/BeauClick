'use client';

import type { ReactNode } from 'react';
import { Badge, ContextBand, NavLink } from './kit';
import { useProProfile } from '@/lib/pro-context';
import type { MyProviderProfile } from '@/lib/pro-api';

/**
 * The professional context bar.
 *
 * The UI/UX audit's §4 finding was that V3 has "no visual distinction between
 * customer, business, and (absent) professional contexts". Task 1 added the
 * third context here and established the pattern: a tinted band, directly under
 * the app header, that names the mode, shows who you are operating as, carries
 * the mode's own navigation, and always offers the way back out.
 *
 * Phase A then copied that pattern into `AdminShell`. Phase G moved the
 * pattern itself into `ContextBand` in the kit, so this file is now the
 * professional context's CONTENT and nothing else -- which is what it always
 * should have been. The band still sits INSIDE the existing `AppShell` rather
 * than replacing it: a separate chrome would mean a second header, a second
 * nav, a second skip-link target and a second place for the notification badge
 * to drift out of sync.
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
  const ready = state === 'ready' && profile;

  return (
    <div>
      <ContextBand
        tone="primary"
        modeLabel="حالت متخصص"
        identity={ready ? profile.displayName : undefined}
        status={ready ? <VerificationBadge status={profile.verificationStatus} /> : undefined}
        exitHref="/"
        exitLabel="بازگشت به نمای مشتری"
        navLabel="ناوبری متخصص"
      >
        {PRO_NAV.map((item) => (
          <NavLink key={item.href} href={item.href} underline>
            {item.label}
          </NavLink>
        ))}
      </ContextBand>

      {children}
    </div>
  );
}
