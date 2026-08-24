'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, toPersianDigits, zonedIsoDate } from '@beauclick/persian-utils';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { EmptyState, PageHeader, Select } from '@/components/pro-ui';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  myMetrics,
  mySeries,
  SERIES_EVENTS,
  type ProviderMetrics,
  type SeriesEvent,
  type SeriesResponse,
} from '@/lib/pro-api';

export default function ProAnalyticsPage() {
  return <ProGuard>{() => <Analytics />}</ProGuard>;
}

const EVENT_LABELS: Record<SeriesEvent, string> = {
  BookingCreated: 'رزروهای ثبت‌شده',
  BookingCompleted: 'نوبت‌های انجام‌شده',
  BookingCancelled: 'رزروهای لغوشده',
  ProviderProfileViewed: 'بازدید از پروفایل',
  OrderPaid: 'پرداخت‌های موفق',
  SearchPerformed: 'جست‌وجوها',
};

const FUNNEL_LABELS: Record<string, string> = {
  created: 'رزرو ثبت‌شده',
  confirmed: 'تأیید شده',
  completed: 'انجام شده',
  cancelled: 'لغو شده',
  expired: 'منقضی شده',
  profileViews: 'بازدید پروفایل',
};

/**
 * The professional's own analytics.
 *
 * Same isolation property as the finance screen: `/v1/me/analytics` has no
 * provider parameter at all -- the subject is resolved from the session
 * through a port -- so there is nothing to tamper with.
 *
 * Everything rendered here comes from `MetricsService`, which
 * `V3_DOMAIN_BOUNDARIES.md` names as "the one computation every consumer
 * (dashboards, AI) must call, never a second parallel engine". This screen
 * therefore does no arithmetic of its own beyond formatting: `completionRate`
 * is the server's own figure, not a ratio recomputed in the browser, which is
 * precisely how two engines start.
 */
function Analytics() {
  const { api } = useAuth();

  const [metrics, setMetrics] = useState<ProviderMetrics | null>(null);
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [event, setEvent] = useState<SeriesEvent>('BookingCompleted');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Thirty platform-local days. `zonedIsoDate` rather than
    // `toISOString().slice(0,10)`: the analytics range is a PLATFORM day
    // boundary (`analytics/platform-day.ts` uses Asia/Tehran), so a browser
    // west of Iran computing "today" in its own zone would silently ask for
    // the wrong window.
    const to = zonedIsoDate(new Date());
    const from = zonedIsoDate(new Date(Date.now() - 30 * 86_400_000));
    try {
      const [metricsRes, seriesRes] = await Promise.all([
        myMetrics(api, { from, to }),
        mySeries(api, event, { from, to }),
      ]);
      setMetrics(metricsRes.data ?? null);
      setSeries(seriesRes.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'آمار بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, event]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !loaded) return <LoadingState label="در حال بارگذاری آمار…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const funnel = metrics?.funnel;
  const totalActivity = funnel
    ? funnel.created.value + funnel.completed.value + funnel.cancelled.value + funnel.profileViews.value
    : 0;
  const maxPoint = series?.points.reduce((max, p) => Math.max(max, p.count), 0) ?? 0;

  return (
    <>
      <PageHeader title="آمار" subtitle="عملکرد ۳۰ روز گذشته شما." />

      {/* An honest empty state: the server ANSWERED and every counter is zero.
          That is a real fact about a new professional, not a failure, and it
          is deliberately not dressed up with placeholder numbers. */}
      {loaded && totalActivity === 0 ? (
        <EmptyState message="هنوز فعالیتی برای نمایش نیست. با ثبت زمان‌های آزاد و دریافت اولین رزرو، آمار شما اینجا ظاهر می‌شود." />
      ) : null}

      {funnel ? (
        <div
          style={{
            display: 'grid',
            gap: 'var(--bc-spacing-card-gap)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            marginBlockEnd: 20,
          }}
        >
          {Object.entries(FUNNEL_LABELS).map(([key, label]) => {
            const metric = funnel[key as keyof typeof funnel];
            if (!metric) return null;
            return (
              <Card key={key}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>{label}</p>
                <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
                  {toPersianDigits(metric.value)}
                </p>
              </Card>
            );
          })}
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>نرخ انجام</p>
            <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
              {toPersianDigits(Math.round(funnel.completionRate.value * 100))}٪
            </p>
          </Card>
        </div>
      ) : null}

      {metrics && Object.keys(metrics.revenue ?? {}).length > 0 ? (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>درآمد</h2>
          <div
            style={{
              display: 'grid',
              gap: 'var(--bc-spacing-card-gap)',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              marginBlockEnd: 20,
            }}
          >
            {Object.entries(metrics.revenue).map(([key, metric]) => (
              <Card key={key}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>{revenueLabel(key)}</p>
                <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>
                  {key.toLowerCase().includes('toman') || metric.key.includes('toman')
                    ? formatToman(metric.value)
                    : toPersianDigits(metric.value)}
                </p>
              </Card>
            ))}
          </div>
        </>
      ) : null}

      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>روند روزانه</h2>
      <Card>
        <Select label="رویداد" value={event} onChange={(e) => setEvent(e.target.value as SeriesEvent)}>
          {SERIES_EVENTS.map((key) => (
            <option key={key} value={key}>
              {EVENT_LABELS[key]}
            </option>
          ))}
        </Select>

        {!series || series.points.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: 0 }}>
            در این بازه رویدادی ثبت نشده است.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {series.points.map((point) => (
              <li key={point.day} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ minWidth: 96, color: 'var(--bc-color-ink-soft)', direction: 'ltr', textAlign: 'start' }}>
                  {toPersianDigits(point.day)}
                </span>
                {/* A proportional bar, not a charting library: one dependency
                    is not worth adding for six rows, and `aria-hidden` keeps
                    the decoration out of the accessible name -- the number
                    beside it is the real content. */}
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    height: 8,
                    borderRadius: 999,
                    background: 'var(--bc-color-primary)',
                    width: maxPoint > 0 ? `${Math.max(4, (point.count / maxPoint) * 100)}%` : 4,
                  }}
                />
                {/* `count`, not `sum`: the series is "how many of this event
                    happened that day". `sum` aggregates metric VALUES and is
                    zero for count-only events, which would render every bar
                    label as ۰. */}
                <span style={{ fontWeight: 700 }}>{toPersianDigits(point.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

const REVENUE_LABELS: Record<string, string> = {
  grossToman: 'فروش ناخالص',
  refundedToman: 'بازگشت وجه',
  netToman: 'فروش خالص',
  paidOrders: 'سفارش‌های پرداخت‌شده',
  averageOrderToman: 'میانگین هر سفارش',
};

/** Persian label, falling back to a generic Persian phrase rather than the raw English key (QA-22's class). */
function revenueLabel(key: string): string {
  return REVENUE_LABELS[key] ?? 'شاخص مالی';
}
