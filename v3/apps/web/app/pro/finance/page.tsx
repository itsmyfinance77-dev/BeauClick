'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader } from '@/components/pro-ui';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  financeSummary,
  orderLedger,
  outstandingOrders,
  settlements,
  type FinanceSummary,
  type LedgerEntry,
  type OutstandingOrder,
  type SettlementBatch,
} from '@/lib/pro-api';

export default function ProFinancePage() {
  return <ProGuard>{() => <Finance />}</ProGuard>;
}

/**
 * The professional's own earnings.
 *
 * Every request on this screen is a `/v1/me/finance/...` route that takes NO
 * party argument of any kind -- not in the path, not in the query, not in the
 * body. `MyFinanceService` resolves the party internally from the session
 * (the GAP-05 fix), so there is nothing here a tampered client could point at
 * another professional's figures. This component could not leak cross-party
 * data if it tried, because it cannot express the request.
 *
 * The per-order ledger is the one route that takes an id, and it takes an
 * ORDER id, not a party id: `myLedgerForOrder` filters to the caller's own
 * party, so a foreign order returns an empty list rather than someone else's
 * rows.
 */
function Finance() {
  const { api } = useAuth();

  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [orders, setOrders] = useState<OutstandingOrder[]>([]);
  const [batches, setBatches] = useState<SettlementBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, ordersRes, batchesRes] = await Promise.all([
        financeSummary(api),
        outstandingOrders(api),
        settlements(api),
      ]);
      setSummary(summaryRes.data ?? null);
      setOrders(ordersRes.data ?? []);
      setBatches(batchesRes.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات مالی بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleLedger(orderId: string) {
    if (ledgerFor === orderId) {
      setLedgerFor(null);
      return;
    }
    setLedgerFor(orderId);
    setLedger([]);
    setLedgerError(null);
    setLedgerLoading(true);
    try {
      const res = await orderLedger(api, orderId);
      setLedger(res.data ?? []);
    } catch (err) {
      setLedgerError(err instanceof Error ? err.message : 'ریز تراکنش بارگذاری نشد.');
    } finally {
      setLedgerLoading(false);
    }
  }

  if (loading && !loaded) return <LoadingState label="در حال بارگذاری اطلاعات مالی…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader
        title="مالی"
        subtitle="درآمد شما از رزروهای پرداخت‌شده، پس از کسر کارمزد پلتفرم."
        action={
          summary ? (
            <Badge tone={summary.partyType === 'business' ? 'primary' : 'neutral'}>
              {summary.partyType === 'business' ? 'درآمد به حساب کسب‌وکار' : 'درآمد شخصی'}
            </Badge>
          ) : undefined
        }
      />

      {summary ? (
        <div
          style={{
            display: 'grid',
            gap: 'var(--bc-spacing-card-gap)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            marginBlockEnd: 20,
          }}
        >
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>خالص قابل دریافت</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>
              {formatToman(summary.receivableNetToman)}
            </p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>تسویه‌شده</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>{formatToman(summary.settledToman)}</p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>در انتظار تسویه</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>{formatToman(summary.outstandingToman)}</p>
          </Card>
        </div>
      ) : null}

      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>سفارش‌های در انتظار تسویه</h2>
      {orders.length === 0 ? (
        <EmptyState message="سفارشی در انتظار تسویه ندارید." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {orders.map((order) => (
            <Card key={order.orderId}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--bc-spacing-chip-gap)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{formatToman(order.outstandingToman)}</p>
                  {/* The API returns the order id and the outstanding amount
                      and nothing else -- no date. A truncated reference is what
                      there actually is to show; a date here would have to be
                      invented. */}
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                    سفارش{' '}
                    <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                      {order.orderId.slice(0, 8)}
                    </span>
                  </p>
                </div>
                <Button type="button" variant="ghost" inline onClick={() => void toggleLedger(order.orderId)}>
                  {ledgerFor === order.orderId ? 'بستن ریز تراکنش' : 'ریز تراکنش'}
                </Button>
              </div>

              {ledgerFor === order.orderId ? (
                <div
                  style={{
                    marginBlockStart: 16,
                    paddingBlockStart: 16,
                    borderBlockStart: '1px solid var(--bc-color-line)',
                  }}
                >
                  {ledgerLoading ? (
                    <LoadingState label="در حال بارگذاری ریز تراکنش…" />
                  ) : ledgerError ? (
                    <ErrorState message={ledgerError} onRetry={() => void toggleLedger(order.orderId)} />
                  ) : ledger.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: 0 }}>
                      تراکنشی برای این سفارش ثبت نشده است.
                    </p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <caption style={{ textAlign: 'start', fontWeight: 700, marginBlockEnd: 8 }}>
                        ریز تراکنش سفارش
                      </caption>
                      <tbody>
                        {ledger.map((entry) => (
                          <tr key={entry.id}>
                            <th scope="row" style={{ textAlign: 'start', fontWeight: 600, padding: '4px 0' }}>
                              {entry.entryType === 'commission' ? 'کارمزد پلتفرم' : 'سهم شما'}
                            </th>
                            <td style={{ textAlign: 'end', padding: '4px 0' }}>{formatToman(entry.amountToman)}</td>
                            <td style={{ textAlign: 'end', padding: '4px 0', color: 'var(--bc-color-ink-faint)' }}>
                              {toPersianDigits((entry.commissionRateBp / 100).toFixed(1))}٪
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px' }}>تاریخچه تسویه</h2>
      {batches.length === 0 ? (
        <EmptyState message="هنوز تسویه‌ای انجام نشده است." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {batches.map((batch) => (
            <Card key={batch.id}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--bc-spacing-chip-gap)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{formatToman(batch.amountToman)}</p>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                    {formatZonedFullDate(new Date(batch.createdAt))}
                    {batch.method ? ` — ${batch.method}` : ''}
                  </p>
                </div>
                <Badge tone={batch.kind === 'reversal' ? 'error' : 'success'}>
                  {batch.kind === 'reversal' ? 'برگشت تسویه' : 'تسویه'}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBlockStart: 20 }}>
        تسویه توسط تیم مالی پلتفرم انجام می‌شود. پرداخت خودکار هنوز فعال نیست.
      </p>
    </>
  );
}
