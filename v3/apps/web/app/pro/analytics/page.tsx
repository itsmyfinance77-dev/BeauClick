'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, formatZonedFullDate, toPersianDigits, zonedIsoDate } from '@beauclick/persian-utils';
import { PriceDisplay } from '@/components/price-display';
import { ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, MoneyUnitNote, SegmentedControl, Select, StatCard, StatGrid } from '@/components/kit';
import { MoneyChart, type ChartPoint } from '@/components/money-chart';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  FUNNEL_LABEL,
  NOT_RECORDED_YET,
  SERIES_EVENT_LABEL,
  revenueIsMoney,
  revenueLabel,
  seriesMeasure,
} from '@/lib/analytics-labels';
import {
  myMetrics,
  mySeries,
  SERIES_EVENTS,
  type ProviderMetrics,
  type SeriesEvent,
  type SeriesResponse,
} from '@/lib/pro-api';
import styles from './analytics.module.css';

export default function ProAnalyticsPage() {
  return <ProGuard>{() => <Analytics />}</ProGuard>;
}

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

  if (loading && !loaded) return <LoadingState label="در حال بارگذاری آمار…" lines={5} />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const funnel = metrics?.funnel;
  // `profileViews` is not counted: nothing records it yet (see NOT_RECORDED_YET),
  // and it is always zero, so it would never be what makes a screen "active".
  const totalActivity = funnel ? funnel.created.value + funnel.completed.value + funnel.cancelled.value : 0;
  // `loaded` is load-succeeded, not merely load-attempted, so this can never be
  // true because a request failed -- that path returned above.
  const isEmpty = loaded && totalActivity === 0;

  // What one bar measures depends on the event: a paid order's metric is its
  // total in Toman, so its daily sum is gross sales; every other event is a
  // count, and its sum is zero (which would draw a flat chart).
  const measure = seriesMeasure(event);
  const points: ChartPoint[] = (series?.points ?? []).map((point) => ({
    key: point.day,
    // The day is a PLATFORM day (Asia/Tehran); noon UTC-ish keeps the date
    // stable in the platform zone whatever the browser's zone is.
    label: formatZonedFullDate(new Date(`${point.day}T08:30:00.000Z`)),
    value: point[measure.field],
    detail: measure.money ? `${toPersianDigits(point.count)} سفارش` : undefined,
  }));

  return (
    <>
      <PageHeader
        title="آمار"
        subtitle={`عملکرد ${toPersianDigits(days)} روز گذشته شما.`}
        action={
          <SegmentedControl
            label="بازه زمانی"
            value={days}
            options={RANGE_OPTIONS}
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

          It is EXCLUSIVE with the figures below: saying "there is no activity
          to show" directly above a grid of cards showing activity, all of them
          zero, is a contradiction whichever half the reader believes. */}
      {isEmpty ? (
        <EmptyState message="هنوز فعالیتی برای نمایش نیست. با ثبت زمان‌های آزاد و دریافت اولین رزرو، آمار شما اینجا ظاهر می‌شود." />
      ) : (
        <>
          {funnel ? (
            <div className={styles.section}>
              <StatGrid min={150}>
                {Object.entries(FUNNEL_LABEL).map(([key, label]) => {
                  const metric = funnel[key as keyof typeof funnel];
                  if (!metric) return null;
                  // A counter nothing records is not a zero, it is unknown:
                  // a dash and «به‌زودی», never a number that reads as a fact.
                  if (NOT_RECORDED_YET.has(key)) {
                    return (
                      <StatCard
                        key={key}
                        label={label}
                        value="—"
                        footer={<span className={styles.soon}>به‌زودی</span>}
                      />
                    );
                  }
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
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>درآمد</h2>
              <MoneyUnitNote />
              <StatGrid>
                {Object.entries(metrics.revenue).map(([key, metric]) => (
                  <StatCard
                    key={key}
                    label={revenueLabel(key)}
                    value={revenueIsMoney(key) ? <PriceDisplay amount={metric.value} /> : toPersianDigits(metric.value)}
                  />
                ))}
              </StatGrid>
            </div>
          ) : null}
        </>
      )}

      <h2 className={styles.sectionTitle}>روند روزانه</h2>
      <div className={styles.panel}>
        <div className={styles.picker}>
          <Select label="رویداد" value={event} onChange={(e) => setEvent(e.target.value as SeriesEvent)}>
            {SERIES_EVENTS.map((key) => {
              const soon = NOT_RECORDED_YET.has(key);
              return (
                <option key={key} value={key} disabled={soon}>
                  {SERIES_EVENT_LABEL[key]}
                  {soon ? ' (به‌زودی)' : ''}
                </option>
              );
            })}
          </Select>
        </div>

        <MoneyChart
          points={points}
          loading={loading}
          title={`روند روزانهٔ ${SERIES_EVENT_LABEL[event]}`}
          formatValue={measure.money ? formatMoney : toPersianDigits}
          valueHeading={measure.money ? 'فروش' : 'تعداد'}
          detailHeading="سفارش"
          emptyMessage="هنوز داده‌ای برای این بازه نیست."
        />
        {points.length > 0 && !loading && measure.money ? <Badge tone="neutral">ارتفاع هر میله، فروش همان روز است</Badge> : null}
      </div>
    </>
  );
}

/** A Toman amount with its unit: the chart's tooltip and summary name the currency, as the design asks. */
const formatMoney = (value: number) => `${formatToman(value)} تومان`;

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
  { value: 7, label: '۷ روز' },
  { value: 30, label: '۳۰ روز' },
  { value: 90, label: '۹۰ روز' },
] as const;

type RangeDays = (typeof RANGE_OPTIONS)[number]['value'];
