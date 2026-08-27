'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, toPersianDigits, zonedIsoDate } from '@beauclick/persian-utils';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { EmptyState, PageHeader, Select, StatCard, StatGrid } from '@/components/kit';
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
  const [days, setDays] = useState<RangeDays>(30);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Platform-local days. `zonedIsoDate` rather than
    // `toISOString().slice(0,10)`: the analytics range is a PLATFORM day
    // boundary (`analytics/platform-day.ts` uses Asia/Tehran), so a browser
    // west of Iran computing "today" in its own zone would silently ask for
    // the wrong window.
    const to = zonedIsoDate(new Date());
    const from = zonedIsoDate(new Date(Date.now() - days * 86_400_000));
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
  }, [api, event, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !loaded) return <LoadingState label="در حال بارگذاری آمار…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const funnel = metrics?.funnel;
  const totalActivity = funnel
    ? funnel.created.value + funnel.completed.value + funnel.cancelled.value + funnel.profileViews.value
    : 0;
  // `loaded` is load-succeeded, not merely load-attempted, so this can never be
  // true because a request failed -- that path returned above.
  const isEmpty = loaded && totalActivity === 0;
  const maxPoint = series?.points.reduce((max, p) => Math.max(max, p.count), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="آمار"
        subtitle={`عملکرد ${toPersianDigits(days)} روز گذشته شما.`}
        action={
          <RangePicker
            value={days}
            onChange={setDays}
            // The whole screen re-requests on change, so blocking the control
            // while that is in flight stops a second range landing on top of a
            // first one still on the wire.
            disabled={loading}
          />
        }
      />

      {/* An honest empty state: the server ANSWERED and every counter is zero.
          That is a real fact about a new professional, not a failure, and it
          is deliberately not dressed up with placeholder numbers.

          It is EXCLUSIVE with the figures below, which it previously was not:
          the message "there is no activity to show" rendered directly above a
          grid of cards showing activity, all of them zero. Saying nothing and
          then showing something is a contradiction whichever half the reader
          believes. */}
      {isEmpty ? (
        <EmptyState message="هنوز فعالیتی برای نمایش نیست. با ثبت زمان‌های آزاد و دریافت اولین رزرو، آمار شما اینجا ظاهر می‌شود." />
      ) : (
        <>
          {funnel ? (
            <div style={{ marginBlockEnd: 20 }}>
              <StatGrid min={150}>
                {Object.entries(FUNNEL_LABELS).map(([key, label]) => {
                  const metric = funnel[key as keyof typeof funnel];
                  if (!metric) return null;
                  return <StatCard key={key} label={label} value={toPersianDigits(metric.value)} />;
                })}
                <StatCard
                  label="نرخ انجام"
                  value={`${toPersianDigits(Math.round(funnel.completionRate.value * 100))}٪`}
                />
              </StatGrid>
            </div>
          ) : null}

          {metrics && Object.keys(metrics.revenue ?? {}).length > 0 ? (
            <div style={{ marginBlockEnd: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>درآمد</h2>
              <StatGrid>
                {Object.entries(metrics.revenue).map(([key, metric]) => (
                  <StatCard
                    key={key}
                    label={revenueLabel(key)}
                    value={
                      key.toLowerCase().includes('toman') || metric.key.includes('toman')
                        ? formatToman(metric.value)
                        : toPersianDigits(metric.value)
                    }
                  />
                ))}
              </StatGrid>
            </div>
          ) : null}
        </>
      )}

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

/**
 * The reporting window, in platform-local days.
 *
 * The screen was previously hard-wired to 30 and offered no way to ask a
 * different question, even though `/v1/me/analytics` and its `/series` sibling
 * have both accepted `from`/`to` since Phase 3. Three fixed windows rather than
 * two date fields: a professional wants "this week" or "this quarter", not a
 * date-arithmetic exercise, and fixed options cannot produce an inverted or
 * absurdly wide range for the server to reject.
 */
const RANGE_OPTIONS = [
  { days: 7, label: '۷ روز' },
  { days: 30, label: '۳۰ روز' },
  { days: 90, label: '۹۰ روز' },
] as const;

type RangeDays = (typeof RANGE_OPTIONS)[number]['days'];

function RangePicker({
  value,
  onChange,
  disabled,
}: {
  value: RangeDays;
  onChange: (days: RangeDays) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="بازه زمانی"
      style={{ display: 'flex', gap: 'var(--bc-spacing-chip-gap)', flexWrap: 'wrap' }}
    >
      {RANGE_OPTIONS.map((option) => {
        const isCurrent = option.days === value;
        return (
          <button
            key={option.days}
            type="button"
            // `aria-pressed` rather than `aria-selected`: these are toggle
            // buttons in a group, not tabs in a tablist, and claiming the
            // wrong role would promise keyboard behaviour (arrow-key
            // traversal) that is not implemented here.
            aria-pressed={isCurrent}
            disabled={disabled}
            onClick={() => onChange(option.days)}
            style={{
              font: 'inherit',
              fontSize: 13,
              fontWeight: isCurrent ? 800 : 600,
              minHeight: 44,
              padding: '0 14px',
              borderRadius: 999,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              border: `1px solid ${isCurrent ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
              background: isCurrent ? 'var(--bc-color-primary-soft)' : 'transparent',
              color: isCurrent ? 'var(--bc-color-primary)' : 'var(--bc-color-ink)',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
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
