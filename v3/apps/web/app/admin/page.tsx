'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, toPersianDigits, zonedIsoDate } from '@beauclick/persian-utils';
import { ErrorState, LoadingState } from '@/components/ui';
import { Badge, PageHeader, StatCard, StatGrid, TextLink } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import {
  notificationStatus,
  phoneConflicts,
  platformMetrics,
  searchStatus,
  verificationQueue,
  type PlatformMetrics,
} from '@/lib/admin-api';

/**
 * The operator's landing screen.
 *
 * Its job is to answer one question -- "is anything waiting for me?" -- before
 * anything else. An overview that leads with totals looks impressive and tells
 * an operator nothing they need to act on; the queues come first here, and the
 * platform figures come second.
 */
export default function AdminOverviewPage() {
  const { api, user } = useAuth();

  const [pendingVerifications, setPendingVerifications] = useState<number | null>(null);
  const [openConflicts, setOpenConflicts] = useState<number | null>(null);
  const [deadLetters, setDeadLetters] = useState<number | null>(null);
  const [stalePending, setStalePending] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canModerate = user?.capabilities?.includes('bc_moderate_verification') ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const to = zonedIsoDate(new Date());
    const from = zonedIsoDate(new Date(Date.now() - 30 * 86_400_000));
    try {
      // Each panel is tolerated independently. One failing queue must not blank
      // the whole overview -- an operator with a broken search index still
      // needs to see the verification queue.
      const [verifications, conflicts, notifications, search, platform] = await Promise.all([
        canModerate ? verificationQueue(api, 1, 1).catch(() => null) : Promise.resolve(null),
        phoneConflicts(api, { page: 1 }).catch(() => null),
        notificationStatus(api).catch(() => null),
        searchStatus(api).catch(() => null),
        platformMetrics(api, { from, to }).catch(() => null),
      ]);

      setPendingVerifications(verifications?.meta?.pagination?.total ?? null);
      setOpenConflicts(conflicts?.meta?.pagination?.total ?? null);
      setDeadLetters(notifications?.data?.deadLetters.total ?? null);
      setStalePending(
        typeof search?.data?.stalePendingOverFiveMinutes === 'number'
          ? search.data.stalePendingOverFiveMinutes
          : null,
      );
      setMetrics(platform?.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'نمای کلی بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, canModerate]);

  useEffect(() => {
    void load();
  }, [load]);

  const queues: Array<{ label: string; count: number | null; href: string; urgentAbove: number }> = [
    ...(canModerate
      ? [{ label: 'درخواست احراز هویت', count: pendingVerifications, href: '/admin/verification', urgentAbove: 0 }]
      : []),
    { label: 'تعارض شماره بررسی‌نشده', count: openConflicts, href: '/admin/phone-conflicts', urgentAbove: 0 },
    { label: 'اعلان ناموفق نهایی', count: deadLetters, href: '/admin/notifications', urgentAbove: 0 },
    { label: 'سند معطل در نمایه', count: stalePending, href: '/admin/search', urgentAbove: 0 },
  ];

  return (
    <>
      <PageHeader title="نمای کلی" subtitle="کارهایی که در انتظار بررسی شماست." />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" />
      ) : (
        <>
          <StatGrid min={190}>
            {/* `null` means the request FAILED -- not zero. Showing a confident
                "۰" for a queue we could not read would tell an operator there
                is no work when there may be plenty. */}
            {queues.map((queue) => (
              <StatCard
                key={queue.href}
                label={queue.label}
                value={queue.count === null ? '—' : toPersianDigits(queue.count)}
                footer={
                  <>
                    {queue.count === null ? (
                      <Badge tone="neutral">خوانده نشد</Badge>
                    ) : queue.count > queue.urgentAbove ? (
                      <Badge tone="warning">نیازمند بررسی</Badge>
                    ) : (
                      <Badge tone="success">بدون مورد</Badge>
                    )}
                    <TextLink href={queue.href}>مشاهده</TextLink>
                  </>
                }
              />
            ))}
          </StatGrid>

          {metrics ? (
            <div style={{ marginBlockStart: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>پلتفرم در ۳۰ روز گذشته</h2>
              <StatGrid min={170}>
                <StatCard label="رزروهای ثبت‌شده" value={toPersianDigits(metrics.bookings.created.value)} />
                <StatCard label="نوبت‌های انجام‌شده" value={toPersianDigits(metrics.bookings.completed.value)} />
                <StatCard label="فروش ناخالص" value={formatToman(metrics.commerce.grossToman.value)} />
                <StatCard
                  label="جست‌وجوی بدون نتیجه"
                  value={`${toPersianDigits(Math.round(metrics.search.emptyResultRate.value * 100))}٪`}
                />
              </StatGrid>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
