import type { BadgeTone } from '@/components/kit';
import type { BookingHistoryEntry } from './pro-api';

/**
 * How a booking's status, and each event in its history, are named on the
 * professional's screens.
 *
 * Both tables are keyed by a server enum — `BOOKING_STATUSES` and
 * `BOOKING_HISTORY_EVENTS` (`booking.entity.ts`, `booking-history.entity.ts`).
 * `booking-status.spec.ts` reads both lists and fails when either drifts, in
 * either direction, so a status the server adds cannot reach a Persian screen
 * as an English key.
 */
export const BOOKING_STATUS_LABEL: Record<string, string> = {
  pending: 'در انتظار پرداخت',
  confirmed: 'تأیید شده',
  completed: 'انجام شد',
  cancelled: 'لغو شده',
  expired: 'منقضی شده',
  no_show: 'عدم حضور',
};

export const BOOKING_STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warning',
  confirmed: 'primary',
  completed: 'success',
  cancelled: 'neutral',
  expired: 'neutral',
  no_show: 'error',
};

export const UNKNOWN_BOOKING_STATUS_LABEL = 'نامشخص';

export function bookingStatusLabel(status: string): string {
  return BOOKING_STATUS_LABEL[status] ?? UNKNOWN_BOOKING_STATUS_LABEL;
}

export function bookingStatusTone(status: string): BadgeTone {
  return BOOKING_STATUS_TONE[status] ?? 'neutral';
}

export const BOOKING_HISTORY_EVENT_LABEL: Record<string, string> = {
  created: 'ایجاد رزرو',
  confirmed: 'تأیید رزرو',
  completed: 'ثبت انجام نوبت',
  cancelled: 'لغو رزرو',
  expired: 'انقضای رزرو',
  no_show: 'ثبت عدم حضور',
  rescheduled: 'تغییر زمان',
};

/**
 * A history event's Persian label, falling back to the status transition
 * rather than to the raw English key: the event vocabulary can grow, and
 * `no_show` must never be rendered into a Persian UI as `no_show`.
 */
export function bookingHistoryLabel(entry: Pick<BookingHistoryEntry, 'event' | 'toStatus'>): string {
  const known = BOOKING_HISTORY_EVENT_LABEL[entry.event];
  if (known) return known;
  if (entry.toStatus && BOOKING_HISTORY_EVENT_LABEL[entry.toStatus]) return BOOKING_HISTORY_EVENT_LABEL[entry.toStatus];
  return 'تغییر وضعیت رزرو';
}
