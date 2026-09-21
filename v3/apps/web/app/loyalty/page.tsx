'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, PageHeader, ProgressBar } from '@/components/kit';
import { loyaltyReasonLabel } from '@/lib/loyalty-reasons';
import { loyaltyHistory, loyaltySummary, type LoyaltyHistoryEntry, type LoyaltySummary } from '@/lib/phase3-api';
import styles from './loyalty.module.css';

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
  // The history is paginated by the server; only the first page used to be
  // reachable. `historyPage` is the last page fetched.
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPages, setHistoryPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, h] = await Promise.all([loyaltySummary(api), loyaltyHistory(api)]);
      setSummary(s.data);
      setHistory(h.data?.items ?? []);
      setHistoryPage(1);
      setHistoryPages(h.data?.pagination?.totalPages ?? 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات باشگاه مشتریان بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = historyPage + 1;
      const h = await loyaltyHistory(api, next);
      // Appended and keyed by the row's own id, so a page that overlaps the
      // last (a row written between the two requests) cannot show twice.
      setHistory((current) => {
        const seen = new Set(current.map((e) => e.id));
        return [...current, ...(h.data?.items ?? []).filter((e) => !seen.has(e.id))];
      });
      setHistoryPage(next);
      setHistoryPages(h.data?.pagination?.totalPages ?? next);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : 'بارگذاری بیشتر انجام نشد.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <LoadingState label="در حال بارگذاری…" lines={5} />;
  // An error offers a retry, like the other customer pages: a bare alert left
  // the customer with no way forward but reloading the tab.
  if (error || !summary) {
    return <ErrorState message={error ?? 'اطلاعات باشگاه مشتریان بارگذاری نشد.'} onRetry={() => void load()} />;
  }

  return (
    <section>
      <PageHeader title="باشگاه مشتریان" />

      <div className={styles.columns}>
        <div className={styles.stack}>
          <div className={styles.panel} data-testid="loyalty-summary">
            <div className={styles.figures}>
              <div>
                <p className={styles.figureLabel}>امتیاز قابل استفاده</p>
                <p className={styles.figure}>{toPersianDigits(summary.balance)}</p>
              </div>
              <div>
                {/* Two different numbers, shown side by side deliberately: spending
                    points reduces the balance but never the lifetime total, which
                    is what tier qualification uses. */}
                <p className={styles.figureLabel}>مجموع امتیاز کسب‌شده</p>
                <p className={styles.figure}>{toPersianDigits(summary.lifetimeEarned)}</p>
              </div>
            </div>

            {summary.tier && (
              <p className={styles.tier}>
                سطح فعلی شما: <strong>{summary.tier.name}</strong>
              </p>
            )}

            {summary.nextTier && summary.pointsToNextTier !== null && (
              <div className={styles.progress}>
                <p className={styles.progressText}>
                  <span>
                    {toPersianDigits(summary.pointsToNextTier)} امتیاز تا سطح {summary.nextTier.name}
                  </span>
                  <span>{toPersianDigits(Math.round(summary.percentToNextTier ?? 0))}٪</span>
                </p>
                <ProgressBar value={summary.percentToNextTier ?? 0} label={`پیشرفت تا سطح ${summary.nextTier.name}`} />
              </div>
            )}
          </div>

          {summary.membership && (
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>عضویت</h2>
              <p className={styles.membershipName}>
                <strong>{summary.membership.planName}</strong>{' '}
                {summary.membership.status !== 'active' && <Badge tone="neutral">غیرفعال</Badge>}
              </p>
              {summary.membership.expiresAt && (
                <p className={styles.until}>تا {formatFullJalaliDate(new Date(summary.membership.expiresAt))}</p>
              )}
            </div>
          )}

          {summary.benefits.length > 0 && (
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>مزایای شما</h2>
              <ul className={styles.benefits}>
                {summary.benefits.map((benefit, index) => (
                  <li key={`${benefit.type}-${index}`}>{benefit.label}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>تاریخچه امتیاز</h2>
          {history.length === 0 ? (
            <p className={styles.empty}>هنوز امتیازی ثبت نشده است.</p>
          ) : (
            <>
              <ul className={styles.history}>
                {history.map((entry) => (
                  <li key={entry.id} className={styles.row} data-entry={entry.id}>
                    <div>
                      <p className={styles.reason}>{loyaltyReasonLabel(entry.reason)}</p>
                      <p className={styles.when}>{formatFullJalaliDate(new Date(entry.createdAt))}</p>
                      {entry.multiplierBp > 10000 && (
                        <p className={styles.boost}>شامل ضریب مزایا (پایه: {toPersianDigits(entry.basePoints)})</p>
                      )}
                    </div>
                    {/* A redemption or a reversal is a negative row; the sign is the
                        whole meaning, so it is printed rather than only coloured. */}
                    <p className={`${styles.points} ${entry.points < 0 ? styles.pointsOut : ''}`}>
                      {entry.points >= 0 ? '+' : '−'}
                      {toPersianDigits(Math.abs(entry.points))}
                    </p>
                  </li>
                ))}
              </ul>
              {moreError && <Alert tone="error">{moreError}</Alert>}
              {historyPage < historyPages ? (
                <div className={styles.more}>
                  <Button variant="ghost" inline onClick={() => void loadMore()} loading={loadingMore}>
                    نمایش بیشتر
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
