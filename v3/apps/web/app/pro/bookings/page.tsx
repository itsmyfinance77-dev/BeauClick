'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatToman,
  formatZonedFullDate,
  formatZonedTime,
  toPersianDigits,
  zonedIsoDate,
} from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Select } from '@/components/kit';
import { TabList, TabPanel } from '@/components/tab-list';
import { bookingHistoryLabel, bookingStatusLabel, bookingStatusTone } from '@/lib/booking-status';
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
  type ProfessionalBookingSummary,
  type MyProviderProfile,
  type MySlot,
  type ServiceOffering,
} from '@/lib/pro-api';
import styles from './bookings.module.css';

export default function ProBookingsPage() {
  return <ProGuard>{(profile) => <ProBookings profile={profile} />}</ProGuard>;
}

/** Mirrors `BookingConfig` defaults. Used ONLY to explain why a button is absent, never to authorize. */
const MAX_RESCHEDULES = 2;
const RESCHEDULE_MIN_HOURS = 6;

/** `PageQueryDto` caps `limit` at 100; 50 keeps a comfortable margin under it. */
const PAGE_SIZE = 50;

type Tab = 'upcoming' | 'past' | 'cancelled';

/** Each tab's own empty sentence: "nothing ahead", "no history" and "nothing cancelled" are different facts. */
const EMPTY: Record<Tab, string> = {
  upcoming: 'رزرو پیش‌رویی ندارید. مطمئن شوید زمان‌های آزاد ثبت کرده‌اید تا مشتری بتواند شما را رزرو کند.',
  past: 'هنوز رزرو گذشته‌ای ندارید.',
  cancelled: 'رزرو لغوشده‌ای ندارید.',
};

function ProBookings({ profile }: { profile: MyProviderProfile }) {
  const { api } = useAuth();

  const [bookings, setBookings] = useState<ProfessionalBookingSummary[]>([]);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('upcoming');

  // How many pages are currently held, and how many bookings exist in total.
  //
  // The screen previously asked for `(1, 50)` and stopped there, so a
  // professional with more than fifty bookings simply could not reach the
  // fifty-first -- and nothing said so, which is the worse half: the list
  // ended and looked complete. `total` comes from the response's own
  // pagination meta, so "you have more" is the server's claim rather than an
  // inference from a full-looking page.
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ booking: ProfessionalBookingSummary; action: 'complete' | 'no_show' } | null>(null);

  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<BookingHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [reschedulingFor, setReschedulingFor] = useState<ProfessionalBookingSummary | null>(null);
  const [openSlots, setOpenSlots] = useState<MySlot[]>([]);
  const [targetSlot, setTargetSlot] = useState('');
  const [slotsError, setSlotsError] = useState<string | null>(null);

  /**
   * Re-reads every page currently held, not just the first.
   *
   * Every state-changing action on this screen calls this, and resetting to
   * page 1 would silently discard pages the professional had already asked
   * for -- completing a booking on page 3 would drop them back to page 1. The
   * pages are re-read rather than patched because a completion can move a
   * booking between the upcoming and past partitions and the server is the
   * authority on where it landed.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pageNumbers = Array.from({ length: pages }, (_, i) => i + 1);
      const [bookingPages, serviceRes] = await Promise.all([
        Promise.all(pageNumbers.map((page) => listProfessionalBookings(api, page, PAGE_SIZE))),
        listMyServices(api, profile.id).catch(() => ({ data: [] as ServiceOffering[] })),
      ]);
      setBookings(bookingPages.flatMap((res) => res.data ?? []));
      // The LAST page's meta, because an earlier page's total could have been
      // computed before a concurrent write.
      setTotal(bookingPages[bookingPages.length - 1]?.meta?.pagination?.total ?? null);
      setServices(serviceRes.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست رزروها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, profile.id, pages]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Appends the next page.
   *
   * Deliberately additive rather than a page-swap. The upcoming/past split is
   * computed from what is held, and `listForProfessional` orders by
   * `slotStart DESC`, so future bookings sit at the head of the list and past
   * ones accumulate behind them. Replacing the held page with the next one
   * would empty the "upcoming" tab the moment a professional paged into their
   * history, which is not what "next page" means to a reader looking at tabs.
   */
  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const next = pages + 1;
      const res = await listProfessionalBookings(api, next, PAGE_SIZE);
      setBookings((current) => [...current, ...(res.data ?? [])]);
      setTotal(res.meta?.pagination?.total ?? total);
      setPages(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'بارگذاری رزروهای بیشتر انجام نشد.');
    } finally {
      setLoadingMore(false);
    }
  }

  const serviceName = useCallback(
    (id: string | null) => (id ? services.find((s) => s.id === id)?.name ?? null : null),
    [services],
  );

  const { upcoming, past, cancelled } = useMemo(() => {
    const now = Date.now();
    const up: ProfessionalBookingSummary[] = [];
    const done: ProfessionalBookingSummary[] = [];
    const called: ProfessionalBookingSummary[] = [];
    for (const booking of bookings) {
      // A cancelled booking has its own tab (spec 05: it "has data but no
      // separate filter"). `expired` — an unpaid hold that lapsed — stays with
      // the past: nobody cancelled it.
      if (booking.status === 'cancelled') {
        called.push(booking);
        continue;
      }
      const isOver = new Date(booking.endAt).getTime() <= now;
      const isTerminal = ['completed', 'expired', 'no_show'].includes(booking.status);
      (isOver || isTerminal ? done : up).push(booking);
    }
    up.sort((a, b) => a.startAt.localeCompare(b.startAt));
    done.sort((a, b) => b.startAt.localeCompare(a.startAt));
    called.sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { upcoming: up, past: done, cancelled: called };
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
    setBookings((current) =>
      current.map((booking) =>
        booking.id === updated.id ? { ...updated, customerDisplayName: booking.customerDisplayName } : booking,
      ),
    );
  }

  async function runAction(booking: ProfessionalBookingSummary, action: 'complete' | 'no_show') {
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

  async function openHistory(booking: ProfessionalBookingSummary) {
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

  async function openReschedule(booking: ProfessionalBookingSummary) {
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

  const visible = tab === 'upcoming' ? upcoming : tab === 'past' ? past : cancelled;
  const hasMore = total !== null && bookings.length < total;

  // Grouped by the PLATFORM-local day, not the browser's, so a late-evening
  // Tehran booking is not filed under the wrong date for a viewer elsewhere.
  const days = useMemo(() => {
    const map = new Map<string, ProfessionalBookingSummary[]>();
    for (const booking of visible) {
      const key = zonedIsoDate(new Date(booking.startAt));
      const list = map.get(key) ?? [];
      list.push(booking);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [visible]);

  // These are counts of what is HELD, not of what exists. With more pages
  // unread the honest suffix is "+", not a total the screen cannot
  // substantiate for this partition -- the server's `total` counts every
  // booking, not one tab's share of them.
  const count = (n: number) => `${toPersianDigits(n)}${hasMore ? '+' : ''}`;
  const tabs = [
    { value: 'upcoming', label: `پیش‌رو (${count(upcoming.length)})` },
    { value: 'past', label: `گذشته (${count(past.length)})` },
    { value: 'cancelled', label: `لغوشده (${count(cancelled.length)})` },
  ] as const;

  return (
    <>
      <PageHeader
        title="رزروها"
        subtitle="رزروهای مشتریان شما. پس از پایان نوبت، وضعیت آن را ثبت کنید."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {actionError ? <Alert>{actionError}</Alert> : null}

      <TabList label="فیلتر رزروها" idPrefix="pro-bookings" tabs={tabs} value={tab} onChange={setTab} />

      <TabPanel idPrefix="pro-bookings" value={tab}>
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری رزروها…" lines={5} />
        ) : loaded && visible.length === 0 ? (
          <EmptyState message={EMPTY[tab]} />
        ) : (
          days.map(([day, dayBookings]) => (
            <section key={day} className={styles.day} data-day={day}>
              <h2 className={styles.dayTitle}>{formatZonedFullDate(new Date(dayBookings[0].startAt))}</h2>
              <ul className={styles.rows}>
                {dayBookings.map((booking) => {
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

                  const noShowNote = booking.status === 'confirmed' && !ended;
                  const rescheduleNote = (booking.status === 'confirmed' || booking.status === 'pending') && !canReschedule;

                  return (
                    <li key={booking.id} className={styles.booking} data-booking={booking.id}>
                      <div className={styles.info}>
                        <p className={styles.when}>{formatZonedFullDate(start)}</p>
                        <p className={styles.time}>
                          ساعت <span className={styles.clock}>{formatZonedTime(start)}</span> تا{' '}
                          <span className={styles.clock}>{formatZonedTime(new Date(booking.endAt))}</span>
                        </p>
                        <p className={styles.service}>
                          {name ?? 'خدمت نامشخص'}
                          {service ? ` — ${formatToman(service.priceToman)}` : ''}
                        </p>
                        <p className={styles.meta}>
                          مشتری: {booking.customerDisplayName ?? 'نام مشتری ثبت نشده'}
                        </p>
                        {booking.rescheduleCount > 0 ? (
                          <p className={styles.meta}>{toPersianDigits(booking.rescheduleCount)} بار جابه‌جا شده</p>
                        ) : null}
                      </div>
                      <div className={styles.status}>
                        <Badge tone={bookingStatusTone(booking.status)}>{bookingStatusLabel(booking.status)}</Badge>
                      </div>

                      <div className={styles.actions}>
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

                      {historyFor === booking.id ? (
                        <div className={styles.history}>
                          {historyLoading ? (
                            <LoadingState label="در حال بارگذاری تاریخچه…" lines={2} />
                          ) : historyError ? (
                            <ErrorState message={historyError} onRetry={() => void openHistory(booking)} />
                          ) : history.length === 0 ? (
                            <p className={styles.emptyHistory}>رویدادی برای این رزرو ثبت نشده است.</p>
                          ) : (
                            <ul className={styles.historyList}>
                              {history.map((entry) => (
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
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </TabPanel>

      {/* Outside the tab partition on purpose: the next page can contain rows
          for any tab, so hiding this while one tab is open would leave a
          professional unable to reach older bookings from the very tab that
          holds them. */}
      {loaded && hasMore ? (
        <div className={styles.more}>
          <Button type="button" variant="ghost" inline loading={loadingMore} onClick={() => void loadMore()}>
            بارگذاری رزروهای بیشتر
          </Button>
          <p className={styles.moreNote}>
            {toPersianDigits(bookings.length)} از {toPersianDigits(total ?? 0)} رزرو بارگذاری شده است.
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.action === 'complete' ? 'ثبت انجام نوبت' : 'ثبت عدم حضور مشتری'}
        tone={confirming?.action === 'complete' ? 'primary' : 'danger'}
        confirmLabel={confirming?.action === 'complete' ? 'بله، انجام شد' : 'بله، مشتری نیامد'}
        busy={busyId !== null}
        onConfirm={() => confirming && void runAction(confirming.booking, confirming.action)}
        onCancel={() => setConfirming(null)}
        // The consequence text is the dialog's accessible description: a
        // screen-reader user hears what confirming does, not just its title.
        describedById="pro-bookings-confirm-consequence"
        body={
          <div id="pro-bookings-confirm-consequence">
            {confirming?.action === 'complete' ? (
              <>
                <p className={styles.dialogText}>این نوبت به‌عنوان «انجام‌شده» ثبت می‌شود.</p>
                <p className={styles.dialogLast}>
                  پس از ثبت، امتیاز باشگاه مشتری، مسیر زیبایی او و آمار شما به‌روزرسانی می‌شود. این عملیات برگشت‌پذیر نیست.
                </p>
              </>
            ) : (
              <p className={styles.dialogLast}>این نوبت به‌عنوان «عدم حضور» ثبت می‌شود. این عملیات برگشت‌پذیر نیست.</p>
            )}
          </div>
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
              <p className={styles.dialogText}>
                زمان فعلی: {formatZonedFullDate(new Date(reschedulingFor.startAt))} ساعت{' '}
                {formatZonedTime(new Date(reschedulingFor.startAt))}
              </p>
            ) : null}
            {slotsError ? <Alert>{slotsError}</Alert> : null}
            {!slotsError && openSlots.length === 0 ? (
              <p className={styles.dialogLast}>
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
