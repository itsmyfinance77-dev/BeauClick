'use client';

import { Badge } from './kit';
import type { MyProviderProfile } from '@/lib/pro-api';

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
 *
 * It lives in its own module rather than in `pro-shell.tsx` because the shell
 * and the phone sheet both show it, and the sheet is imported BY the shell --
 * reaching back into the shell for the badge would be a cycle.
 */
export function VerificationBadge({ status }: { status: MyProviderProfile['verificationStatus'] }) {
  return <Badge tone={VERIFICATION_TONE[status]}>{VERIFICATION_LABELS[status]}</Badge>;
}
