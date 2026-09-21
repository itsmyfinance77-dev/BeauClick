'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, LoadingState } from '@/components/ui';
import { ConfirmDialog, EmptyState, PageHeader, SegmentedControl, TextLink } from '@/components/kit';
import { bookingApi, isUpcomingBooking, slotTimeLabel, type BookingSummary } from '@/lib/booking-api';
import styles from './bookings.module.css';

const STATUS_FA: Record<BookingSummary['status'], { label: string; tone: string }> = {
  pending: { label: 'در انتظار پرداخت', tone: 'statusWarn' },
  confirmed: { label: 'تأیید شده', tone: 'statusDone' },
  completed: { label: 'انجام شده', tone: 'statusDone' },
  cancelled: { label: 'لغو شده', tone: 'statusError' },
  expired: { label: 'منقضی شده', tone: 'statusNeutral' },
  no_show: { label: 'عدم مراجعه', tone: 'statusError' },
};

type Tab = 'upcoming' | 'past';

const TABS = [
  { value: 'upcoming', label: 'پیش‌رو' },
  { value: 'past', label: 'گذشته' },
] as const;

/** Each tab's own empty sentence: "nothing ahead" and "no history" are different facts. */
const EMPTY: Record<Tab, string> = {
  upcoming: 'نوبت پیش‌رویی ندارید.',
  past: 'هنوز نوبتی در گذشته ثبت نشده است.',
};

/**
 * The customer's own bookings.
 *
 * `expired` and `cancelled` render as visibly different states, which is the
 * user-facing payoff of making expiry a real status rather than a
 * cancellation carrying a reason string: "you did not pay in time" and "you
 * cancelled" are different things to tell someone.
 */
function BookingsContent() {
  const { api } = useAuth();
  const [bookings, setBookings] = useState<BookingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState<BookingSummary | null>(null);
  const [tab, setTab] = useState<Tab>('upcoming');

  const load = useCallback(async () => {
    try {
      const res = await bookingApi.myBookings(api);
      setBookings(res.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(bookingId: string) {
    setBusyId(bookingId);
    setError(null);
    try {
      await bookingApi.cancelBooking(api, bookingId, 'لغو توسط مشتری');
      setPendingCancel(null);
      await load();
    } catch (err) {
      // The dialog closes and the error surfaces on the page: leaving a modal
      // open over an error the user cannot act on inside it is a trap. Same
      // contract the professional surface's destructive actions use.
      setPendingCancel(null);
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusyId(null);
    }
  }

  if (error && !bookings) return <Alert tone="error">{error}</Alert>;
  if (!bookings) return <LoadingState label="در حال بارگذاری رزروها…" lines={4} />;

  if (bookings.length === 0) {
    return (
      <>
        <PageHeader title="رزروهای من" />
        {/* Was a bare `<Link style={{ fontWeight: 600 }}>` -- roughly 29px tall,
            and the SIXTH recorded instance of the touch-target class the UI/UX
            audit tracks as TOUCH-CLASS (25px nav, 43px logout, 21px homepage
            CTA, 24px search result, 18px payment result). `TextLink` exists
            precisely so the baseline is inherited instead of rediscovered;
            this surface simply predates it.

            The heading also dropped from `<h1>` at 22px to 24px via
            `PageHeader`, so the empty and populated states no longer disagree
            about the size of the same page's title. */}
        <EmptyState
          message="هنوز رزروی ثبت نکرده‌اید."
          action={<TextLink href="/providers">مشاهده‌ی متخصص‌ها</TextLink>}
        />
      </>
    );
  }

  // Soonest first ahead, most recent first behind: what you do next is at the
  // top of one tab, what you did last is at the top of the other.
  const upcoming = bookings.filter(isUpcomingBooking).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const past = bookings.filter((b) => !isUpcomingBooking(b)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const shown = tab === 'upcoming' ? upcoming : past;

  return (
    <section>
      <PageHeader title="رزروهای من" />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className={styles.tabs}>
        <SegmentedControl label="فهرست رزروها" value={tab} options={TABS} onChange={setTab} />
      </div>

      {shown.length === 0 ? (
        <EmptyState message={EMPTY[tab]} action={<TextLink href="/search">جست‌وجوی متخصص</TextLink>} />
      ) : (
        <ul className={styles.list} data-testid={`bookings-${tab}`}>
          {shown.map((booking) => {
            const status = STATUS_FA[booking.status];
            // Only a booking that is still ahead can be cancelled. A confirmed one whose
            // time has passed sits on the past tab, where a cancel button would offer to
            // release a slot nobody can take any more.
            const cancellable = isUpcomingBooking(booking);
            return (
              <li key={booking.id} className={styles.card} data-booking={booking.id}>
                <div className={styles.bar}>
                  <p className={styles.when}>{formatFullJalaliDate(new Date(booking.startAt))}</p>
                  <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
                </div>

                <div className={styles.body}>
                  {/* The professional's name goes here when the API carries it
                      (08_BOOKINGS_LIST.md: BACKEND GAP, only the ids come back).
                      Nothing is rendered in its place until then. */}
                  <p className={styles.time}>
                    ساعت <span className={styles.clock}>{slotTimeLabel(booking.startAt)}</span>
                  </p>
                </div>

                {cancellable ? (
                  <div className={styles.actions}>
                    {/* Was a single click straight to cancel(). Cancelling a
                        booking is irreversible, releases the slot to whoever
                        takes it next, and on a paid booking starts a refund --
                        the most consequential action a customer can take in
                        this product, and the only destructive one anywhere in
                        it that had no confirmation. The professional surface
                        confirms every one of its destructive actions through
                        this same dialog. */}
                    <Button
                      variant="danger"
                      inline
                      disabled={busyId === booking.id}
                      onClick={() => setPendingCancel(booking)}
                    >
                      لغو رزرو
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={pendingCancel !== null}
        title="لغو رزرو"
        tone="danger"
        confirmLabel="بله، لغو کن"
        busy={busyId !== null}
        onConfirm={() => pendingCancel && void cancel(pendingCancel.id)}
        onCancel={() => setPendingCancel(null)}
        body={
          pendingCancel ? (
            <>
              <p style={{ margin: '0 0 8px' }}>
                رزرو {formatFullJalaliDate(new Date(pendingCancel.startAt))} ساعت{' '}
                {slotTimeLabel(pendingCancel.startAt)} لغو می‌شود.
              </p>
              <p style={{ margin: 0 }}>این زمان دوباره برای دیگران آزاد می‌شود و این عملیات برگشت‌پذیر نیست.</p>
            </>
          ) : null
        }
      />
    </section>
  );
}

export default function BookingsPage() {
  return (
    <ProtectedRoute>
      <BookingsContent />
    </ProtectedRoute>
  );
}
