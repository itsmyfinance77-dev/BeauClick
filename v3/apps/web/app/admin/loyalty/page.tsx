'use client';

import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, DataCell, DataRow, DataTable, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { loyaltyPolicy, type LoyaltyPolicy } from '@/lib/admin-api';
import styles from './loyalty.module.css';

const POLICY_LABELS: Record<string, string> = {
  pointsBookingCompleted: 'امتیاز هر نوبت انجام‌شده',
  pointsReviewSubmitted: 'امتیاز ثبت دیدگاه',
  pointsOrderCompleted: 'امتیاز هر سفارش',
  pointsReferralQualified: 'امتیاز معرفی موفق',
};

const BASIS_LABELS: Record<string, string> = {
  lifetime: 'مجموع امتیاز کسب‌شده در کل دوره',
  rolling_365: 'امتیاز ۱۲ ماه گذشته',
};

/**
 * Loyalty policy — read-only, and deliberately so.
 *
 * `GET /v1/admin/loyalty/policy` exists to make GAP-10 VISIBLE: every one of
 * these numbers is a V2 placeholder that was never a business decision, and the
 * endpoint reports which ones are still unresolved so a placeholder cannot
 * quietly become de-facto policy because nobody was reminded it was one.
 *
 * There is no edit form here, and that is the point rather than an omission.
 * The values are environment-configurable so that adopting a real policy is a
 * config change; turning them into an admin form would let an operator set the
 * platform's economics from a screen, which is a business decision with no
 * approval trail behind it. GAP-10 asks for a sign-off pass, not a text box.
 */
export default function AdminLoyaltyPage() {
  const { api } = useAuth();

  const [policy, setPolicy] = useState<LoyaltyPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await loyaltyPolicy(api);
      setPolicy(res.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'سیاست باشگاه بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const unresolved = policy?.unresolvedBusinessDecisions ?? [];

  return (
    <>
      <PageHeader
        title="باشگاه مشتریان"
        subtitle="مقادیر فعلی سیاست امتیازدهی. این صفحه فقط خواندنی است."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" />
      ) : policy ? (
        <>
          {unresolved.length > 0 ? (
            <Alert>
              {toPersianDigits(unresolved.length)} مقدار هنوز روی پیش‌فرض موقت نسخه ۲ اجرا می‌شود و تصمیم کسب‌وکار
              درباره آن گرفته نشده است.
            </Alert>
          ) : (
            <Alert tone="success">همه مقادیر سیاست، تعیین‌شده هستند.</Alert>
          )}

          <Card>
            <h2 id="admin-loyalty-policy-heading" className={styles.cardTitle}>
              مقادیر امتیازدهی
            </h2>
            <DataTable head={['رویداد', 'امتیاز', 'وضعیت']} aria-labelledby="admin-loyalty-policy-heading">
              {Object.entries(policy.policy).map(([key, value]) => (
                <DataRow key={key} data-policy={key}>
                  <DataCell label="رویداد">{POLICY_LABELS[key] ?? key}</DataCell>
                  <DataCell label="امتیاز">{toPersianDigits(value)}</DataCell>
                  <DataCell label="وضعیت">
                    {unresolved.includes(key) ? (
                      <Badge tone="warning">تصمیم‌گیری نشده</Badge>
                    ) : (
                      <Badge tone="success">تعیین‌شده</Badge>
                    )}
                  </DataCell>
                </DataRow>
              ))}
            </DataTable>
          </Card>

          <div className={styles.tierSection}>
            <Card>
              <h2 className={styles.tierTitle}>مبنای تعیین سطح</h2>
              <p className={styles.tierValue}>
                {BASIS_LABELS[policy.tierQualificationBasis] ?? policy.tierQualificationBasis}
              </p>
            </Card>
          </div>

          <p className={styles.footnote}>
            تغییر این مقادیر از طریق پیکربندی محیط انجام می‌شود، نه از این صفحه. تعیین سیاست نهایی یک تصمیم
            کسب‌وکار است و نیازمند تأیید رسمی است.
          </p>
        </>
      ) : null}
    </>
  );
}
