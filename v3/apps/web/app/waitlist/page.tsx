'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatFullJalaliDate, formatTime, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, type BadgeTone } from '@/components/kit';
import {
  acceptWaitlistOffer,
  declineWaitlistOffer,
  myWaitlistEntries,
  removeWaitlistEntry,
  type WaitlistEntry,
  type WaitlistStatus,
} from '@/lib/phase4-api';
import { remainingLabel } from '@/lib/remaining-time';
import styles from './waitlist.module.css';

const STATUS_LABELS: Record<WaitlistStatus, string> = {
  waiting: 'در صف انتظار',
  offered: 'نوبت پیشنهاد شده',
  accepted: 'پذیرفته شد',
  declined: 'رد شد',
  expired: 'منقضی شد',
  missed: 'از دست رفت',
  removed: 'حذف شد',
};

// A live offer is the one state that asks for action, so it takes the warning
// tone (`11_WAITLIST.md`); the rest are informative.
const STATUS_TONE: Record<WaitlistStatus, BadgeTone> = {
  waiting: 'neutral',
  offered: 'warning',
  accepted: 'success',
  declined: 'neutral',
  expired: 'error',
  missed: 'error',
  removed: 'neutral',
};


export default function WaitlistPage() {
  return (
    <ProtectedRoute>
      <Waitlist />
    </ProtectedRoute>
  );
}

function Waitlist() {
  const { api } = useAuth();
  const router = useRouter();
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // See notifications/page.tsx: an empty list after a FAILED load must not
  // claim the user is on no waitlists.
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await myWaitlistEntries(api);
      setEntries(res.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'لیست انتظار بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(entry: WaitlistEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      await acceptWaitlistOffer(api, entry.id);
      router.push('/bookings');
    } catch (err) {
      // The slot may have just gone to a faster direct customer -- an
      // honest, expected outcome (GAP-26), not a bug. Refresh so the entry's
      // real status ('missed') replaces the stale 'offered' row on screen.
      setError(err instanceof Error ? err.message : 'این نوبت دیگر در دسترس نیست.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function decline(entry: WaitlistEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      await declineWaitlistOffer(api, entry.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(entry: WaitlistEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      await removeWaitlistEntry(api, entry.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState label="در حال بارگذاری…" lines={4} />;
  if (!loaded) return <ErrorState message={error ?? 'لیست انتظار بارگذاری نشد.'} onRetry={() => void load()} />;

  const now = Date.now();
  const liveOffers = entries.filter((e) => e.status === 'offered').length;

  return (
    <section>
      <PageHeader title="لیست انتظار من" />
      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* A polite announcement when an offer is waiting, so a screen-reader user
          is not left to discover a ticking deadline by reading every row. */}
      <p role="status" aria-live="polite" className={styles.live}>
        {liveOffers > 0 ? `${toPersianDigits(liveOffers)} پیشنهاد نوبت منتظر پاسخ شماست.` : ''}
      </p>

      {entries.length === 0 ? (
        <EmptyState message="در حال حاضر در هیچ لیست انتظاری قرار ندارید." />
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => {
            const offered = entry.status === 'offered';
            return (
              <li key={entry.id} className={`${styles.row} ${offered ? styles.offer : ''}`} data-entry={entry.id}>
                <div className={styles.head}>
                  <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABELS[entry.status]}</Badge>
                  <p className={styles.since}>عضویت در {formatFullJalaliDate(new Date(entry.createdAt))}</p>
                </div>

                {offered && entry.offerExpiresAt ? (
                  <p className={styles.deadline}>
                    تا ساعت{' '}
                    <span className={styles.clock}>{toPersianDigits(formatTime(new Date(entry.offerExpiresAt)))}</span> فرصت
                    دارید پاسخ دهید.
                    <span className={styles.remaining}>{remainingLabel(entry.offerExpiresAt, now)}</span>
                  </p>
                ) : null}

                {offered ? (
                  <div className={styles.actions}>
                    <Button inline onClick={() => void accept(entry)} loading={busyId === entry.id}>
                      پذیرفتن و رزرو
                    </Button>
                    <Button inline variant="ghost" onClick={() => void decline(entry)} disabled={busyId === entry.id}>
                      رد کردن
                    </Button>
                  </div>
                ) : null}

                {entry.status === 'waiting' ? (
                  <div className={styles.actions}>
                    <Button inline variant="ghost" onClick={() => void remove(entry)} loading={busyId === entry.id}>
                      خروج از لیست انتظار
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
