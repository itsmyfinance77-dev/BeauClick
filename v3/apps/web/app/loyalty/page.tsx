'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Card, LoadingState } from '@/components/ui';
import { loyaltyHistory, loyaltySummary, type LoyaltyHistoryEntry, type LoyaltySummary } from '@/lib/phase3-api';

const REASON_LABELS: Record<string, string> = {
  booking_completed: 'انجام خدمت',
  review_submitted: 'ثبت نظر',
  order_completed: 'خرید',
  referral_qualified: 'معرفی دوستان',
  manual_adjustment: 'تعدیل دستی',
};

export default function LoyaltyPage() {
  return (
    <ProtectedRoute>
      <Loyalty />
    </ProtectedRoute>
  );
}

function Loyalty() {
  const { api } = useAuth();
  const [summary, setSummary] = useState<LoyaltySummary | null>(null);
  const [history, setHistory] = useState<LoyaltyHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([loyaltySummary(api), loyaltyHistory(api)]);
      setSummary(s.data);
      setHistory(h.data?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات باشگاه مشتریان بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="در حال بارگذاری…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!summary) return null;

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 16 }}>باشگاه مشتریان</h1>

      <Card>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>امتیاز قابل استفاده</p>
            <p style={{ margin: '4px 0 0', fontSize: 28, fontWeight: 800 }}>{toPersianDigits(summary.balance)}</p>
          </div>
          <div>
            {/* Two different numbers, shown side by side deliberately: spending
                points reduces the balance but never the lifetime total, which
                is what tier qualification uses. */}
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>مجموع امتیاز کسب‌شده</p>
            <p style={{ margin: '4px 0 0', fontSize: 28, fontWeight: 800 }}>{toPersianDigits(summary.lifetimeEarned)}</p>
          </div>
        </div>

        {summary.tier && (
          <p style={{ marginBlockStart: 16, marginBlockEnd: 0, fontSize: 15 }}>
            سطح فعلی شما: <strong>{summary.tier.name}</strong>
          </p>
        )}

        {summary.nextTier && summary.pointsToNextTier !== null && (
          <div style={{ marginBlockStart: 12 }}>
            <p style={{ margin: '0 0 6px', fontSize: 14 }}>
              {toPersianDigits(summary.pointsToNextTier)} امتیاز تا سطح {summary.nextTier.name}
            </p>
            <div
              role="progressbar"
              aria-valuenow={Math.round(summary.percentToNextTier ?? 0)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`پیشرفت تا سطح ${summary.nextTier.name}`}
              style={{
                height: 8,
                borderRadius: 999,
                background: 'var(--bc-color-surface-muted)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${summary.percentToNextTier ?? 0}%`,
                  height: '100%',
                  background: 'var(--bc-color-primary)',
                }}
              />
            </div>
          </div>
        )}
      </Card>

      {summary.membership && (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>عضویت</h2>
          <p style={{ margin: 0, fontSize: 15 }}>
            <strong>{summary.membership.planName}</strong>
            {summary.membership.status !== 'active' && (
              <span style={{ color: 'var(--bc-color-ink-faint)' }}> (غیرفعال)</span>
            )}
          </p>
          {summary.membership.expiresAt && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>
              تا {formatFullJalaliDate(new Date(summary.membership.expiresAt))}
            </p>
          )}
        </Card>
      )}

      {summary.benefits.length > 0 && (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>مزایای شما</h2>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {summary.benefits.map((benefit, index) => (
              <li key={`${benefit.type}-${index}`} style={{ fontSize: 14, marginBlockEnd: 4 }}>
                {benefit.label}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <h2 style={{ fontSize: 18, marginBlockStart: 24 }}>تاریخچه امتیاز</h2>
      {history.length === 0 ? (
        <Card>
          <p style={{ margin: 0 }}>هنوز امتیازی ثبت نشده است.</p>
        </Card>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {history.map((entry) => (
            <li key={entry.id}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 15 }}>{REASON_LABELS[entry.reason] ?? entry.reason}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                      {formatFullJalaliDate(new Date(entry.createdAt))}
                    </p>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontWeight: 700,
                      // A redemption is a negative row; the sign is the whole
                      // meaning, so it is rendered explicitly rather than
                      // relying on colour alone.
                      color: entry.points >= 0 ? 'var(--bc-color-ink)' : 'var(--bc-color-ink-faint)',
                    }}
                  >
                    {entry.points >= 0 ? '+' : '−'}
                    {toPersianDigits(Math.abs(entry.points))}
                  </p>
                </div>
                {entry.multiplierBp > 10000 && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    شامل ضریب مزایا (پایه: {toPersianDigits(entry.basePoints)})
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
