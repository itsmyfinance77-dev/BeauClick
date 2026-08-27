'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, LoadingState } from '@/components/ui';
import { ConfirmDialog, EmptyState, PageHeader, TextLink } from '@/components/kit';
import { bookingApi, slotTimeLabel, type BookingSummary } from '@/lib/booking-api';

const STATUS_FA: Record<BookingSummary['status'], { label: string; tone: string }> = {
  pending: { label: 'در انتظار پرداخت', tone: 'var(--bc-color-warning)' },
  confirmed: { label: 'تأیید شده', tone: 'var(--bc-color-success)' },
  completed: { label: 'انجام شده', tone: 'var(--bc-color-ink-soft)' },
  cancelled: { label: 'لغو شده', tone: 'var(--bc-color-error)' },
  expired: { label: 'منقضی شده', tone: 'var(--bc-color-ink-faint)' },
  no_show: { label: 'عدم مراجعه', tone: 'var(--bc-color-error)' },
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
  if (!bookings) return <LoadingState label="در حال بارگذاری رزروها…" />;

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

  return (
    <section>
      <PageHeader title="رزروهای من" />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
        {bookings.map((booking) => {
          const status = STATUS_FA[booking.status];
          const cancellable = booking.status === 'pending' || booking.status === 'confirmed';
          return (
            <li key={booking.id}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 700 }}>{formatFullJalaliDate(new Date(booking.startAt))}</p>
                    <p style={{ margin: '4px 0 0', color: 'var(--bc-color-ink-soft)', fontSize: 14 }}>
                      ساعت{' '}
                      <span style={{ direction: 'ltr', display: 'inline-block' }}>
                        {toPersianDigits(slotTimeLabel(booking.startAt))}
                      </span>
                    </p>
                  </div>
                  <span style={{ color: status.tone, fontWeight: 700, fontSize: 14 }}>{status.label}</span>
                </div>

                {cancellable ? (
                  <div style={{ marginBlockStart: 16 }}>
                    {/* Was a single click straight to `cancel()`. Cancelling a
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
              </Card>
            </li>
          );
        })}
      </ul>

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
                {toPersianDigits(slotTimeLabel(pendingCancel.startAt))} لغو می‌شود.
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
