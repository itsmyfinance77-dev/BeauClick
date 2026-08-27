'use client';

import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits, zonedIsoDate } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, PageHeader } from '@/components/pro-ui';
import { useAuth } from '@/lib/auth-context';
import {
  platformMetrics,
  rebuildSearchProjection,
  reindexSearch,
  searchStatus,
  type PlatformMetrics,
  type SearchIndexStatus,
} from '@/lib/admin-api';

/**
 * Search index health and quality.
 *
 * The two recovery actions here are the ONLY path back from a corrupted or
 * stale index, and until Phase A no account could reach them -- the routes
 * existed and `bc_manage_platform` was ungrantable (R31-01).
 *
 * The quality metrics are computed by `MetricsService`, which
 * `V3_DOMAIN_BOUNDARIES.md` names as the one computation every consumer must
 * call. This screen does no arithmetic of its own: `emptyResultRate` and
 * `clickThroughRate` are the server's own figures, not ratios recomputed in the
 * browser, which is how two engines start.
 */
export default function AdminSearchPage() {
  const { api } = useAuth();

  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const [pending, setPending] = useState<'reindex' | 'rebuild' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const to = zonedIsoDate(new Date());
    const from = zonedIsoDate(new Date(Date.now() - 30 * 86_400_000));
    try {
      const [statusRes, metricsRes] = await Promise.all([searchStatus(api), platformMetrics(api, { from, to })]);
      setStatus(statusRes.data ?? null);
      setMetrics(metricsRes.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'وضعیت جست‌وجو بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (pending === 'reindex') {
        const res = await reindexSearch(api);
        setResult(`${toPersianDigits(res.data?.indexed ?? 0)} سند دوباره نمایه شد.`);
      } else {
        const res = await rebuildSearchProjection(api);
        setResult(
          `${toPersianDigits(res.data?.projectionRows ?? 0)} ردیف پروجکشن بازسازی و ${toPersianDigits(
            res.data?.indexed ?? 0,
          )} سند نمایه شد.`,
        );
      }
      setPending(null);
      await load();
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : 'اجرای عملیات انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  const search = metrics?.search;

  return (
    <>
      <PageHeader title="جست‌وجو" subtitle="سلامت نمایه و کیفیت نتایج در ۳۰ روز گذشته." />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {result ? <Alert tone="success">{result}</Alert> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری وضعیت…" />
      ) : (
        <>
          {status ? (
            <Card>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>وضعیت نمایه</h2>
              <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
                <p style={{ margin: 0 }}>
                  نمایه فعلی:{' '}
                  <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                    {status.physicalIndex}
                  </span>
                </p>
                <p style={{ margin: 0 }}>
                  اسناد در انتظار: {toPersianDigits(status.pendingDocuments)}{' '}
                  {status.stalePendingOverFiveMinutes > 0 ? (
                    <Badge tone="error">
                      {toPersianDigits(status.stalePendingOverFiveMinutes)} مورد بیش از ۵ دقیقه معطل
                    </Badge>
                  ) : (
                    <Badge tone="success">بدون تأخیر</Badge>
                  )}
                </p>
              </div>
            </Card>
          ) : null}

          {search ? (
            <div style={{ marginBlockStart: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>کیفیت نتایج</h2>
              <div
                style={{
                  display: 'grid',
                  gap: 'var(--bc-spacing-card-gap)',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                }}
              >
                <Card>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>جست‌وجوها</p>
                  <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
                    {toPersianDigits(search.searches.value)}
                  </p>
                </Card>
                <Card>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>بدون نتیجه</p>
                  <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
                    {toPersianDigits(Math.round(search.emptyResultRate.value * 100))}٪
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    {toPersianDigits(search.emptyResultSearches.value)} از {toPersianDigits(search.searches.value)}
                  </p>
                </Card>
                <Card>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>نرخ کلیک</p>
                  <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
                    {toPersianDigits(Math.round(search.clickThroughRate.value * 100))}٪
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    {toPersianDigits(search.searchSourcedViews.value)} بازدید با منشأ جست‌وجو
                  </p>
                </Card>
                <Card>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>حالت اضطراری</p>
                  <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>
                    {toPersianDigits(search.degradedSearches.value)}
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    نتایج سرو‌شده بدون موتور جست‌وجو
                  </p>
                </Card>
              </div>
              {/* The server's own caveat, shown rather than dropped: numerator
                  and denominator are different event types, so one search
                  yielding three views produces a rate above 100%. */}
              {search.clickThroughRate.note ? (
                <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBlockStart: 12 }}>
                  {search.clickThroughRate.note}
                </p>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginBlockStart: 20 }}>
            <Card>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>بازیابی</h2>
              <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 16px' }}>
                این عملیات‌ها پرهزینه هستند و در زمان اجرا بار قابل توجهی به سیستم وارد می‌کنند.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Button type="button" variant="ghost" inline onClick={() => setPending('reindex')}>
                  بازسازی نمایه
                </Button>
                <Button type="button" variant="danger" inline onClick={() => setPending('rebuild')}>
                  بازسازی کامل پروجکشن
                </Button>
              </div>
            </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending === 'reindex' ? 'بازسازی نمایه جست‌وجو' : 'بازسازی کامل پروجکشن'}
        tone={pending === 'rebuild' ? 'danger' : 'primary'}
        confirmLabel="اجرا کن"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
        body={
          pending === 'reindex' ? (
            <p style={{ margin: 0 }}>
              همه اسناد از پروجکشن فعلی دوباره در موتور جست‌وجو نمایه می‌شوند. نتایج در حین اجرا ممکن است ناقص باشد.
            </p>
          ) : (
            <>
              <p style={{ margin: '0 0 8px' }}>
                پروجکشن از داده اصلی متخصص‌ها بازسازی و سپس کل نمایه ساخته می‌شود.
              </p>
              <p style={{ margin: 0 }}>این عملیات سنگین‌تر است و فقط برای بازیابی از خرابی داده استفاده می‌شود.</p>
            </>
          )
        }
      />
    </>
  );
}
