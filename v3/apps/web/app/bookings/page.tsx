'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, LoadingState } from '@/components/ui';
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusyId(null);
    }
  }

  if (error && !bookings) return <Alert tone="error">{error}</Alert>;
  if (!bookings) return <LoadingState label="در حال بارگذاری رزروها…" />;

  if (bookings.length === 0) {
    return (
      <Card>
        <h1 style={{ fontSize: 22, marginBlockEnd: 8 }}>رزروهای من</h1>
        <p style={{ color: 'var(--bc-color-ink-soft)' }}>هنوز رزروی ثبت نکرده‌اید.</p>
        <div style={{ marginBlockStart: 16 }}>
          <Link href="/providers" style={{ fontWeight: 600 }}>
            مشاهده‌ی متخصص‌ها
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 16 }}>رزروهای من</h1>
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
                  <div style={{ marginBlockStart: 16, maxWidth: 200 }}>
                    <Button variant="ghost" loading={busyId === booking.id} onClick={() => void cancel(booking.id)}>
                      لغو رزرو
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
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
