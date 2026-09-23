'use client';

import {
  formatToman,
  formatZonedFullDate,
  formatZonedTime,
  toPersianDigits,
} from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge } from '@/components/kit';
import { bookingHistoryLabel, bookingStatusLabel, bookingStatusTone } from '@/lib/booking-status';
import type { BookingHistoryEntry, ProfessionalBookingSummary, ServiceOffering } from '@/lib/pro-api';
import styles from './booking-row.module.css';

/** Mirrors `BookingConfig` defaults. Used ONLY to explain why a button is absent, never to authorize. */
const MAX_RESCHEDULES = 2;
const RESCHEDULE_MIN_HOURS = 6;

/**
 * A professional's own booking, grouped by day on `pro/bookings`.
 *
 * `V3_COMPONENT_INVENTORY.md` lists this separately from the customer's
 * `BookingCard` — the customer's is a card per booking, this is a row grouped
 * under a day heading, and they genuinely do different jobs.
 */
export function BookingRow({
  booking,
  serviceName,
  service,
  busy,
  onComplete,
  onNoShow,
  onReschedule,
  historyOpen,
  historyLoading,
  historyError,
  history,
  onToggleHistory,
  onRetryHistory,
}: {
  booking: ProfessionalBookingSummary;
  serviceName: string | null;
  service: ServiceOffering | undefined;
  busy: boolean;
  onComplete: () => void;
  onNoShow: () => void;
  onReschedule: () => void;
  historyOpen: boolean;
  historyLoading: boolean;
  historyError: string | null;
  history: BookingHistoryEntry[];
  onToggleHistory: () => void;
  onRetryHistory: () => void;
}) {
  const start = new Date(booking.startAt);
  const ended = new Date(booking.endAt).getTime() <= Date.now();
  const hoursUntil = (start.getTime() - Date.now()) / 3_600_000;

  const canComplete = booking.status === 'confirmed';
  const canNoShow = booking.status === 'confirmed' && ended;
  const canReschedule =
    (booking.status === 'confirmed' || booking.status === 'pending') &&
    booking.rescheduleCount < MAX_RESCHEDULES &&
    hoursUntil >= RESCHEDULE_MIN_HOURS;

  const noShowNote = booking.status === 'confirmed' && !ended;
  const rescheduleNote = (booking.status === 'confirmed' || booking.status === 'pending') && !canReschedule;

  return (
    <li className={styles.booking} data-booking={booking.id}>
      <div className={styles.info}>
        <p className={styles.when}>{formatZonedFullDate(start)}</p>
        <p className={styles.time}>
          ساعت <span className={styles.clock}>{formatZonedTime(start)}</span> تا{' '}
          <span className={styles.clock}>{formatZonedTime(new Date(booking.endAt))}</span>
        </p>
        <p className={styles.service}>
          {serviceName ?? 'خدمت نامشخص'}
          {service ? ` — ${formatToman(service.priceToman)}` : ''}
        </p>
        <p className={styles.meta}>مشتری: {booking.customerDisplayName ?? 'نام مشتری ثبت نشده'}</p>
        {booking.rescheduleCount > 0 ? (
          <p className={styles.meta}>{toPersianDigits(booking.rescheduleCount)} بار جابه‌جا شده</p>
        ) : null}
      </div>
      <div className={styles.status}>
        <Badge tone={bookingStatusTone(booking.status)}>{bookingStatusLabel(booking.status)}</Badge>
      </div>

      <div className={styles.actions}>
        {canComplete ? (
          <Button type="button" inline loading={busy} onClick={onComplete}>
            ثبت انجام نوبت
          </Button>
        ) : null}
        {canNoShow ? (
          <Button type="button" variant="danger" inline disabled={busy} onClick={onNoShow}>
            عدم حضور مشتری
          </Button>
        ) : null}
        {canReschedule ? (
          <Button type="button" variant="ghost" inline onClick={onReschedule}>
            تغییر زمان
          </Button>
        ) : null}
        <Button type="button" variant="ghost" inline onClick={onToggleHistory}>
          {historyOpen ? 'بستن تاریخچه' : 'تاریخچه'}
        </Button>
      </div>

      {/* Why an action is unavailable, rather than a dead button.
          The server is the authority in every case; these are
          explanations of its rules, not the enforcement of them. */}
      {noShowNote || rescheduleNote ? (
        <div className={styles.notes}>
          {noShowNote ? <p className={styles.note}>ثبت عدم حضور تنها پس از پایان زمان نوبت ممکن است.</p> : null}
          {rescheduleNote ? (
            <p className={styles.note}>
              {booking.rescheduleCount >= MAX_RESCHEDULES
                ? `حداکثر ${toPersianDigits(MAX_RESCHEDULES)} بار جابه‌جایی مجاز است.`
                : `تغییر زمان تا ${toPersianDigits(RESCHEDULE_MIN_HOURS)} ساعت پیش از نوبت ممکن است.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {historyOpen ? (
        <AuditTrail loading={historyLoading} error={historyError} entries={history} onRetry={onRetryHistory} />
      ) : null}
    </li>
  );
}

/**
 * A booking's event history — `V3_COMPONENT_INVENTORY.md`'s `AuditTrail`,
 * extracted out of `pro/bookings` where it rendered in place.
 */
export function AuditTrail({
  loading,
  error,
  entries,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  entries: BookingHistoryEntry[];
  onRetry: () => void;
}) {
  return (
    <div className={styles.history}>
      {loading ? (
        <LoadingState label="در حال بارگذاری تاریخچه…" lines={2} />
      ) : error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : entries.length === 0 ? (
        <p className={styles.emptyHistory}>رویدادی برای این رزرو ثبت نشده است.</p>
      ) : (
        <ul className={styles.historyList}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.historyItem}>
              <span className={styles.historyEvent}>{bookingHistoryLabel(entry)}</span>
              <span className={styles.historyWhen}>
                {' — '}
                {formatZonedFullDate(new Date(entry.createdAt))} ساعت{' '}
                <span className={styles.clock}>{formatZonedTime(new Date(entry.createdAt))}</span>
              </span>
              {entry.reason ? <span className={styles.historyReason}>{` — ${entry.reason}`}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
