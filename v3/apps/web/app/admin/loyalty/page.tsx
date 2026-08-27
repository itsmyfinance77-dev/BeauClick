'use client';

import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { loyaltyPolicy, type LoyaltyPolicy } from '@/lib/admin-api';

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
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>مقادیر امتیازدهی</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <caption style={{ textAlign: 'start', fontWeight: 600, marginBlockEnd: 8, fontSize: 13 }}>
                امتیاز اعطاشده برای هر رویداد
              </caption>
              <tbody>
                {Object.entries(policy.policy).map(([key, value]) => (
                  <tr key={key} style={{ borderBlockEnd: '1px solid var(--bc-color-line)' }}>
                    <th scope="row" style={{ textAlign: 'start', fontWeight: 600, padding: '10px 0' }}>
                      {POLICY_LABELS[key] ?? key}
                    </th>
                    <td style={{ textAlign: 'end', padding: '10px 0' }}>{toPersianDigits(value)}</td>
                    <td style={{ textAlign: 'end', padding: '10px 0' }}>
                      {unresolved.includes(key) ? (
                        <Badge tone="warning">تصمیم‌گیری نشده</Badge>
                      ) : (
                        <Badge tone="success">تعیین‌شده</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div style={{ marginBlockStart: 20 }}>
            <Card>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>مبنای تعیین سطح</h2>
              <p style={{ margin: 0, fontSize: 14 }}>
                {BASIS_LABELS[policy.tierQualificationBasis] ?? policy.tierQualificationBasis}
              </p>
            </Card>
          </div>

          <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBlockStart: 20 }}>
            تغییر این مقادیر از طریق پیکربندی محیط انجام می‌شود، نه از این صفحه. تعیین سیاست نهایی یک تصمیم
            کسب‌وکار است و نیازمند تأیید رسمی است.
          </p>
        </>
      ) : null}
    </>
  );
}
