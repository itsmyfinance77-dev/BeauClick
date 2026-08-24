'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatToman,
  formatZonedFullDate,
  formatZonedTime,
  toPersianDigits,
} from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Select } from '@/components/pro-ui';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  bookingHistory,
  completeBooking,
  listMyServices,
  listMySlots,
  listProfessionalBookings,
  markNoShow,
  rescheduleBooking,
  type BookingHistoryEntry,
  type BookingSummary,
  type MyProviderProfile,
  type MySlot,
  type ServiceOffering,
} from '@/lib/pro-api';

export default function ProBookingsPage() {
  return <ProGuard>{(profile) => <ProBookings profile={profile} />}</ProGuard>;
}

const STATUS_LABELS: Record<BookingSummary['status'], string> = {
  pending: 'در انتظار پرداخت',
  confirmed: 'تأیید شده',
  completed: 'انجام شد',
  cancelled: 'لغو شده',
  expired: 'منقضی شده',
  no_show: 'عدم حضور',
};

const STATUS_TONE = {
  pending: 'warning',
  confirmed: 'primary',
  completed: 'success',
  cancelled: 'neutral',
  expired: 'neutral',
  no_show: 'error',
} as const;

/** Mirrors `BookingConfig` defaults. Used ONLY to explain why a button is absent, never to authorize. */
const MAX_RESCHEDULES = 2;
const RESCHEDULE_MIN_HOURS = 6;

type Tab = 'upcoming' | 'past';

function ProBookings({ profile }: { profile: MyProviderProfile }) {
  const { api } = useAuth();

  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('upcoming');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ booking: BookingSummary; action: 'complete' | 'no_show' } | null>(null);

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<BookingHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [reschedulingFor, setReschedulingFor] = useState<BookingSummary | null>(null);
  const [openSlots, setOpenSlots] = useState<MySlot[]>([]);
  const [targetSlot, setTargetSlot] = useState('');
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bookingRes, serviceRes] = await Promise.all([
        listProfessionalBookings(api, 1, 50),
        listMyServices(api, profile.id).catch(() => ({ data: [] as ServiceOffering[] })),
      ]);
      setBookings(bookingRes.data ?? []);
      setServices(serviceRes.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست رزروها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, profile.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const serviceName = useCallback(
    (id: string | null) => (id ? services.find((s) => s.id === id)?.name ?? null : null),
    [services],
  );

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const up: BookingSummary[] = [];
    const done: BookingSummary[] = [];
    for (const booking of bookings) {
      const isOver = new Date(booking.endAt).getTime() <= now;
      const isTerminal = ['completed', 'cancelled', 'expired', 'no_show'].includes(booking.status);
      (isOver || isTerminal ? done : up).push(booking);
    }
    up.sort((a, b) => a.startAt.localeCompare(b.startAt));
    done.sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { upcoming: up, past: done };
  }, [bookings]);

  /**
   * Replaces one booking with the server's own returned state.
   *
   * Deliberately NOT an optimistic update. `complete()` and `markNoShow()`
   * return `false` when the compare-and-swap loses -- a booking cancelled by
   * the customer a second earlier, say -- and the controller then returns the
   * booking's REAL current state with a 200. Optimistically painting
   * "انجام شد" would contradict the server on exactly the races this
   * codebase's CAS discipline exists to handle correctly.
   */
  function applyServerState(updated: BookingSummary) {
    setBookings((current) => current.map((b) => (b.id === updated.id ? updated : b)));
  }

  async function runAction(booking: BookingSummary, action: 'complete' | 'no_show') {
    setBusyId(booking.id);
    setActionError(null);
    try {
      const res = action === 'complete' ? await completeBooking(api, booking.id) : await markNoShow(api, booking.id);
      if (res.data) applyServerState(res.data);
      setConfirming(null);
    } catch (err) {
      setConfirming(null);
      setActionError(err instanceof Error ? err.message : 'انجام این عملیات ممکن نشد.');
      // Reload, do not merely report the error.
      //
      // The commonest reason a complete/no-show is refused is that the card on
      // screen is STALE -- the customer cancelled after this list was fetched,
      // so the server 409s an illegal transition while the UI still shows
      // "تأیید شده". Showing only the message would leave the user staring at
      // a state the server has already disagreed with, and clicking again.
      // Proven by `professional-surface.pg-spec.ts`'s cancelled-booking case.
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function openHistory(booking: BookingSummary) {
    if (historyFor === booking.id) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(booking.id);
    setHistory([]);
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const res = await bookingHistory(api, booking.id);
      setHistory(res.data ?? []);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'تاریخچه رزرو بارگذاری نشد.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openReschedule(booking: BookingSummary) {
    setReschedulingFor(booking);
    setTargetSlot('');
    setSlotsError(null);
    setActionError(null);
    try {
      const res = await listMySlots(api, {
        from: new Date().toISOString(),
        to: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      });
      // Client-side narrowing to what the server would accept anyway: open,
      // not the current slot, and service-compatible. The server re-checks all
      // three (`RescheduleNotAllowedException('invalid_slot')`); this only
      // avoids offering a choice that is guaranteed to fail.
      setOpenSlots(
        (res.data ?? []).filter(
          (slot) =>
            slot.status === 'open' &&
            slot.id !== booking.slotId &&
            (!booking.serviceId || !slot.serviceId || slot.serviceId === booking.serviceId),
        ),
      );
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : 'زمان‌های آزاد بارگذاری نشد.');
    }
  }

  async function submitReschedule() {
    if (!reschedulingFor || !targetSlot) return;
    setBusyId(reschedulingFor.id);
    setActionError(null);
    try {
      const res = await rescheduleBooking(api, reschedulingFor.id, targetSlot);
      if (res.data) applyServerState(res.data);
      setReschedulingFor(null);
      // The old slot is released and the new one claimed, so the availability
      // list this screen filtered from is now stale.
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'تغییر زمان رزرو انجام نشد.');
    } finally {
      setBusyId(null);
    }
  }

  const visible = tab === 'upcoming' ? upcoming : past;

  return (
    <>
      <PageHeader
        title="رزروها"
        subtitle="رزروهای مشتریان شما. پس از پایان نوبت، وضعیت آن را ثبت کنید."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {actionError ? <Alert>{actionError}</Alert> : null}

      <div
        role="tablist"
        aria-label="فیلتر رزروها"
        style={{ display: 'flex', gap: 'var(--bc-spacing-chip-gap)', marginBlockEnd: 16, flexWrap: 'wrap' }}
      >
        {(['upcoming', 'past'] as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            style={{
              font: 'inherit',
              fontSize: 14,
              fontWeight: tab === key ? 800 : 600,
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 999,
              cursor: 'pointer',
              border: `1px solid ${tab === key ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
              background: tab === key ? 'var(--bc-color-primary-soft)' : 'transparent',
              color: tab === key ? 'var(--bc-color-primary)' : 'var(--bc-color-ink)',
            }}
          >
            {key === 'upcoming'
              ? `پیش‌رو (${toPersianDigits(upcoming.length)})`
              : `گذشته (${toPersianDigits(past.length)})`}
          </button>
        ))}
      </div>

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری رزروها…" />
      ) : loaded && visible.length === 0 ? (
        <EmptyState
          message={
            tab === 'upcoming'
              ? 'رزرو پیش‌رویی ندارید. مطمئن شوید زمان‌های آزاد ثبت کرده‌اید تا مشتری بتواند شما را رزرو کند.'
              : 'هنوز رزرو گذشته‌ای ندارید.'
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {visible.map((booking) => {
            const start = new Date(booking.startAt);
            const ended = new Date(booking.endAt).getTime() <= Date.now();
            const hoursUntil = (start.getTime() - Date.now()) / 3_600_000;
            const name = serviceName(booking.serviceId);
            const service = services.find((s) => s.id === booking.serviceId);

            const canComplete = booking.status === 'confirmed';
            const canNoShow = booking.status === 'confirmed' && ended;
            const canReschedule =
              (booking.status === 'confirmed' || booking.status === 'pending') &&
              booking.rescheduleCount < MAX_RESCHEDULES &&
              hoursUntil >= RESCHEDULE_MIN_HOURS;

            return (
              <Card key={booking.id}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 'var(--bc-spacing-chip-gap)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{formatZonedFullDate(start)}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 14 }}>
                      ساعت {formatZonedTime(start)} تا {formatZonedTime(new Date(booking.endAt))}
                    </p>
                    <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                      {name ?? 'خدمت نامشخص'}
                      {service ? ` — ${formatToman(service.priceToman)}` : ''}
                    </p>
                    {/* A truncated customer reference, because a raw identity
                        id is genuinely all the booking API exposes about the
                        customer -- no name, no phone, deliberately. Inventing
                        a friendlier identity would mean fabricating one.
                        Rendered LTR so the hex does not visually reverse
                        inside the RTL document, the same treatment the sandbox
                        transaction reference already gets. */}
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                      مشتری:{' '}
                      <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                        {booking.customerId.slice(0, 8)}
                      </span>
                    </p>
                    {booking.rescheduleCount > 0 ? (
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                        {toPersianDigits(booking.rescheduleCount)} بار جابه‌جا شده
                      </p>
                    ) : null}
                  </div>
                  <Badge tone={STATUS_TONE[booking.status]}>{STATUS_LABELS[booking.status]}</Badge>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBlockStart: 16 }}>
                  {canComplete ? (
                    <Button
                      type="button"
                      inline
                      loading={busyId === booking.id}
                      onClick={() => setConfirming({ booking, action: 'complete' })}
                    >
                      ثبت انجام نوبت
                    </Button>
                  ) : null}
                  {canNoShow ? (
                    <Button
                      type="button"
                      variant="danger"
                      inline
                      disabled={busyId === booking.id}
                      onClick={() => setConfirming({ booking, action: 'no_show' })}
                    >
                      عدم حضور مشتری
                    </Button>
                  ) : null}
                  {canReschedule ? (
                    <Button type="button" variant="ghost" inline onClick={() => void openReschedule(booking)}>
                      تغییر زمان
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" inline onClick={() => void openHistory(booking)}>
                    {historyFor === booking.id ? 'بستن تاریخچه' : 'تاریخچه'}
                  </Button>
                </div>

                {/* Why an action is unavailable, rather than a dead button.
                    The server is the authority in every case; these are
                    explanations of its rules, not the enforcement of them. */}
                {booking.status === 'confirmed' && !ended ? (
                  <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    ثبت عدم حضور تنها پس از پایان زمان نوبت ممکن است.
                  </p>
                ) : null}
                {(booking.status === 'confirmed' || booking.status === 'pending') && !canReschedule ? (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    {booking.rescheduleCount >= MAX_RESCHEDULES
                      ? `حداکثر ${toPersianDigits(MAX_RESCHEDULES)} بار جابه‌جایی مجاز است.`
                      : `تغییر زمان تا ${toPersianDigits(RESCHEDULE_MIN_HOURS)} ساعت پیش از نوبت ممکن است.`}
                  </p>
                ) : null}

                {historyFor === booking.id ? (
                  <div
                    style={{
                      marginBlockStart: 16,
                      paddingBlockStart: 16,
                      borderBlockStart: '1px solid var(--bc-color-line)',
                    }}
                  >
                    {historyLoading ? (
                      <LoadingState label="در حال بارگذاری تاریخچه…" />
                    ) : historyError ? (
                      <ErrorState message={historyError} onRetry={() => void openHistory(booking)} />
                    ) : history.length === 0 ? (
                      <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: 0 }}>
                        رویدادی برای این رزرو ثبت نشده است.
                      </p>
                    ) : (
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                        {history.map((entry) => (
                          <li key={entry.id} style={{ fontSize: 13 }}>
                            <span style={{ fontWeight: 600 }}>{historyLabel(entry)}</span>
                            <span style={{ color: 'var(--bc-color-ink-faint)' }}>
                              {' — '}
                              {formatZonedFullDate(new Date(entry.createdAt))} ساعت{' '}
                              {formatZonedTime(new Date(entry.createdAt))}
                            </span>
                            {entry.reason ? (
                              <span style={{ color: 'var(--bc-color-ink-soft)' }}>{` — ${entry.reason}`}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.action === 'complete' ? 'ثبت انجام نوبت' : 'ثبت عدم حضور مشتری'}
        tone={confirming?.action === 'complete' ? 'primary' : 'danger'}
        confirmLabel={confirming?.action === 'complete' ? 'بله، انجام شد' : 'بله، مشتری نیامد'}
        busy={busyId !== null}
        onConfirm={() => confirming && void runAction(confirming.booking, confirming.action)}
        onCancel={() => setConfirming(null)}
        body={
          confirming?.action === 'complete' ? (
            <>
              <p style={{ margin: '0 0 8px' }}>این نوبت به‌عنوان «انجام‌شده» ثبت می‌شود.</p>
              <p style={{ margin: 0 }}>
                پس از ثبت، امتیاز باشگاه مشتری، مسیر زیبایی او و آمار شما به‌روزرسانی می‌شود. این عملیات برگشت‌پذیر نیست.
              </p>
            </>
          ) : (
            <p style={{ margin: 0 }}>
              این نوبت به‌عنوان «عدم حضور» ثبت می‌شود. این عملیات برگشت‌پذیر نیست.
            </p>
          )
        }
      />

      <ConfirmDialog
        open={reschedulingFor !== null}
        title="تغییر زمان رزرو"
        confirmLabel="انتقال به زمان انتخابی"
        busy={busyId !== null}
        onConfirm={() => void submitReschedule()}
        onCancel={() => setReschedulingFor(null)}
        body={
          <>
            {reschedulingFor ? (
              <p style={{ margin: '0 0 12px' }}>
                زمان فعلی: {formatZonedFullDate(new Date(reschedulingFor.startAt))} ساعت{' '}
                {formatZonedTime(new Date(reschedulingFor.startAt))}
              </p>
            ) : null}
            {slotsError ? <Alert>{slotsError}</Alert> : null}
            {!slotsError && openSlots.length === 0 ? (
              <p style={{ margin: 0 }}>
                زمان آزاد دیگری برای این خدمت ندارید. ابتدا در صفحه «زمان‌های آزاد» زمان جدیدی بسازید.
              </p>
            ) : (
              <Select label="زمان جدید" value={targetSlot} onChange={(e) => setTargetSlot(e.target.value)}>
                <option value="">انتخاب کنید</option>
                {openSlots.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {`${formatZonedFullDate(new Date(slot.startAt))} — ${formatZonedTime(new Date(slot.startAt))}`}
                  </option>
                ))}
              </Select>
            )}
          </>
        }
      />
    </>
  );
}

const HISTORY_EVENT_LABELS: Record<string, string> = {
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
 * rather than to the raw English key.
 *
 * QA-22 records that label maps in this codebase fall back to the raw key,
 * which would render `no_show` into a Persian UI the moment the backend adds
 * an event this map does not know. Booking history is written by
 * `booking.service.ts` and its event vocabulary can grow, so this one falls
 * back to something already Persian instead.
 */
function historyLabel(entry: BookingHistoryEntry): string {
  const known = HISTORY_EVENT_LABELS[entry.event];
  if (known) return known;
  if (entry.toStatus && HISTORY_EVENT_LABELS[entry.toStatus]) return HISTORY_EVENT_LABELS[entry.toStatus];
  return 'تغییر وضعیت رزرو';
}
