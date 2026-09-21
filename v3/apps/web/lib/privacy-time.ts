import { toPersianDigits } from '@beauclick/persian-utils';

/**
 * The erasure countdown, as the design draws it: a date and the days that
 * remain — never a live ticking clock, which would imply a precision the
 * account (usable throughout the window) does not need.
 */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/**
 * «۴ روز دیگر», or «کمتر از یک روز دیگر» once fewer than 24 hours remain (or the
 * moment has just passed and the sweep has not run yet). Rounded UP for whole
 * days, so a window that has just begun reads seven, not six.
 */
export function daysLeftLabel(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms < 86_400_000) return 'کمتر از یک روز دیگر';
  return `${toPersianDigits(daysUntil(iso, now))} روز دیگر`;
}

/** Hands a JSON document to the browser as a file, built on the client — there is no signed URL to follow. */
export function saveJsonFile(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
