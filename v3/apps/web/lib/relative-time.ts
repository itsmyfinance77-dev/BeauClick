import { toPersianDigits } from '@beauclick/persian-utils';

/**
 * How long ago, in words: «۳ هفته پیش». The list of devices reads better as
 * "3 weeks ago" than as a date (`30_DEVICE_SESSIONS.md`).
 *
 * `now` is a parameter, not `Date.now()` inside: a function that reads the
 * clock cannot be tested for its boundaries. A time in the future (a clock that
 * is a little ahead of the server's) reads as «همین حالا» rather than negative.
 */
export function relativePastLabel(iso: string, now: number): string {
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return 'همین حالا';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه پیش`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${toPersianDigits(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${toPersianDigits(days)} روز پیش`;
  if (days < 30) return `${toPersianDigits(Math.floor(days / 7))} هفته پیش`;
  if (days < 365) return `${toPersianDigits(Math.floor(days / 30))} ماه پیش`;
  return `${toPersianDigits(Math.floor(days / 365))} سال پیش`;
}
