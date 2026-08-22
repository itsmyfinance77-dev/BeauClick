'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatFullJalaliDate, formatTime, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, LoadingState } from '@/components/ui';
import {
  acceptWaitlistOffer,
  declineWaitlistOffer,
  myWaitlistEntries,
  removeWaitlistEntry,
  type WaitlistEntry,
  type WaitlistStatus,
} from '@/lib/phase4-api';

const STATUS_LABELS: Record<WaitlistStatus, string> = {
  waiting: 'در صف انتظار',
  offered: 'نوبت پیشنهاد شده',
  accepted: 'پذیرفته شد',
  declined: 'رد شد',
  expired: 'منقضی شد',
  missed: 'از دست رفت',
  removed: 'حذف شد',
};

const STATUS_TONE: Record<WaitlistStatus, 'error' | 'success' | undefined> = {
  waiting: undefined,
  offered: 'success',
  accepted: 'success',
  declined: undefined,
  expired: 'error',
  missed: 'error',
  removed: undefined,
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
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await myWaitlistEntries(api);
      setEntries(res.data ?? []);
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

  if (loading) return <LoadingState label="در حال بارگذاری…" />;

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 16 }}>لیست انتظار من</h1>
      {error ? <Alert tone="error">{error}</Alert> : null}

      {entries.length === 0 ? (
        <Card>
          <p style={{ margin: 0 }}>در حال حاضر در هیچ لیست انتظاری قرار ندارید.</p>
        </Card>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {entries.map((entry) => (
            <li key={entry.id}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 15 }}>
                      وضعیت: <strong>{STATUS_LABELS[entry.status]}</strong>
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                      عضویت در {formatFullJalaliDate(new Date(entry.createdAt))}
                    </p>
                    {entry.status === 'offered' && entry.offerExpiresAt ? (
                      <p style={{ margin: '6px 0 0', fontSize: 13 }}>
                        تا ساعت {toPersianDigits(formatTime(new Date(entry.offerExpiresAt)))} فرصت دارید پاسخ دهید.
                      </p>
                    ) : null}
                  </div>

                  {STATUS_TONE[entry.status] ? (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: 999,
                        background:
                          STATUS_TONE[entry.status] === 'success' ? 'var(--bc-color-success-soft)' : 'var(--bc-color-error-soft)',
                        color: STATUS_TONE[entry.status] === 'success' ? 'var(--bc-color-success)' : 'var(--bc-color-error)',
                      }}
                    >
                      {STATUS_LABELS[entry.status]}
                    </span>
                  ) : null}
                </div>

                {entry.status === 'offered' ? (
                  <div style={{ display: 'flex', gap: 8, marginBlockStart: 16 }}>
                    <Button onClick={() => void accept(entry)} loading={busyId === entry.id}>
                      پذیرفتن و رزرو
                    </Button>
                    <Button variant="ghost" onClick={() => void decline(entry)} disabled={busyId === entry.id}>
                      رد کردن
                    </Button>
                  </div>
                ) : null}

                {entry.status === 'waiting' ? (
                  <div style={{ marginBlockStart: 16 }}>
                    <Button variant="ghost" onClick={() => void remove(entry)} loading={busyId === entry.id}>
                      خروج از لیست انتظار
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
