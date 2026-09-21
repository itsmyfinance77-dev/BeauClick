import { toPersianDigits } from '@beauclick/persian-utils';

/**
 * How long is left, in words — "the remaining time must be explicit"
 * (`11_WAITLIST.md`). A clock time alone makes the customer do subtraction
 * against a deadline that is expiring while they do it.
 *
 * `now` is a parameter, not `Date.now()` inside: a function that reads the
 * clock cannot be tested for its boundaries.
 */
export function remainingLabel(expiresAt: string, now: number): string {
  const minutes = Math.floor((new Date(expiresAt).getTime() - now) / 60000);
  if (minutes < 1) return 'مهلت پاسخ به پایان رسیده است.';
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه مانده`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${toPersianDigits(hours)} ساعت مانده`
    : `${toPersianDigits(hours)} ساعت و ${toPersianDigits(rest)} دقیقه مانده`;
}
