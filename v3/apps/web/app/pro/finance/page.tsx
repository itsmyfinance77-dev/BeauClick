'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, SegmentedControl, StatCard, StatGrid } from '@/components/kit';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  financeSummary,
  financeWorkspaces,
  orderLedger,
  outstandingOrders,
  settlements,
  type FinanceSummary,
  type FinanceWorkspace,
  type LedgerEntry,
  type OutstandingOrder,
  type SettlementBatch,
} from '@/lib/pro-api';

export default function ProFinancePage() {
  return <ProGuard>{() => <Finance />}</ProGuard>;
}

const WORKSPACE_LABEL: Record<FinanceWorkspace['workspaceType'], string> = {
  professional: 'حرفه‌ای',
  business: 'کسب‌وکار',
};

/**
 * A seller's own earnings, per WORKSPACE — V3.3 #72, `V33-DEC-020`.
 *
 * ## Why this screen loads a list first
 *
 * One user may own both a professional profile and a business, and each has its
 * own separate financial position. This screen used to call four singular
 * routes that resolved one party server-side, business-first — so a dual owner
 * was shown their business figures with nothing indicating their professional
 * earnings existed, and an affiliated staff professional was shown their
 * EMPLOYER's whole position.
 *
 * It now reads `/me/finance/workspaces` first and addresses every subsequent
 * request with the `workspaceRef` of the workspace the seller is actually
 * looking at. Which workspace is answered became a question the client asks
 * rather than one the server guesses.
 *
 * ## `workspaceRef` is a routing handle, not a credential
 *
 * It is held in component state for the life of the screen and deliberately not
 * persisted: live ownership is re-verified on every request, so a reference
 * that stops resolving means the workspace list has changed, and the honest
 * response is to re-read the list rather than to retry.
 *
 * ## An empty workspace is a real answer
 *
 * An affiliated professional's own workspace will often be zero, because their
 * earnings genuinely belong to the business they work for. The screen shows
 * that zero. `V33-DEC-020` forbids substituting the employer's figures to make
 * the page look fuller, and a truthful empty state is not an error state —
 * loading, empty, error and retry stay four distinct things here.
 */
function Finance() {
  const { api } = useAuth();

  const [workspaces, setWorkspaces] = useState<FinanceWorkspace[]>([]);
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);

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

  /** The workspace list, and the selection. Re-read whenever a reference stops resolving. */
  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await financeWorkspaces(api);
      const items = res.data?.items ?? [];
      setWorkspaces(items);
      setActiveRef((current) => {
        // Keep the seller where they were if that workspace still exists;
        // otherwise fall back to the first, which is a fresh selection rather
        // than a silent server-side choice.
        if (current && items.some((workspace) => workspace.workspaceRef === current)) return current;
        return items[0]?.workspaceRef ?? null;
      });
      setWorkspacesLoaded(true);
      if (items.length === 0) setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست کسب‌وکارها بارگذاری نشد.');
      setLoading(false);
    }
  }, [api]);

  const load = useCallback(
    async (workspaceRef: string) => {
      setLoading(true);
      setError(null);
      try {
        const [summaryRes, ordersRes, batchesRes] = await Promise.all([
          financeSummary(api, workspaceRef),
          outstandingOrders(api, workspaceRef),
          settlements(api, workspaceRef),
        ]);
        setSummary(summaryRes.data ?? null);
        setOrders(ordersRes.data ?? []);
        setBatches(batchesRes.data?.items ?? []);
        setLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'اطلاعات مالی بارگذاری نشد.');
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!activeRef) return;
    void load(activeRef);
  }, [activeRef, load]);

  /**
   * Switching workspace clears every panel BEFORE the next request starts.
   *
   * Without this, a slow response would leave one workspace's settlements
   * rendered under another's summary — the mixed-cache bug that makes a money
   * screen actively misleading rather than merely stale. The open ledger row is
   * closed for the same reason: its order id belongs to the workspace being
   * left.
   */
  function selectWorkspace(workspaceRef: string) {
    if (workspaceRef === activeRef) return;
    setSummary(null);
    setOrders([]);
    setBatches([]);
    setLedgerFor(null);
    setLedger([]);
    setLedgerError(null);
    setLoaded(false);
    setActiveRef(workspaceRef);
  }

  async function toggleLedger(orderId: string) {
    if (ledgerFor === orderId) {
      setLedgerFor(null);
      return;
    }
    if (!activeRef) return;
    setLedgerFor(orderId);
    setLedger([]);
    setLedgerError(null);
    setLedgerLoading(true);
    try {
      const res = await orderLedger(api, activeRef, orderId);
      setLedger(res.data ?? []);
    } catch (err) {
      setLedgerError(err instanceof Error ? err.message : 'ریز تراکنش بارگذاری نشد.');
    } finally {
      setLedgerLoading(false);
    }
  }

  if (loading && !loaded && !workspacesLoaded) return <LoadingState label="در حال بارگذاری اطلاعات مالی…" />;
  if (error) return <ErrorState message={error} onRetry={() => void loadWorkspaces()} />;

  // Owning no seller workspace is a legitimate state, not a failure. The API
  // returns an empty list rather than a refusal, and so does this screen.
  if (workspacesLoaded && workspaces.length === 0) {
    return (
      <>
        <PageHeader title="مالی" subtitle="درآمد شما از رزروهای پرداخت‌شده، پس از کسر کارمزد پلتفرم." />
        <EmptyState message="هنوز کسب‌وکاری برای نمایش اطلاعات مالی ندارید." />
      </>
    );
  }

  const multiple = workspaces.length > 1;
  const active = workspaces.find((workspace) => workspace.workspaceRef === activeRef);

  return (
    <>
      <PageHeader
        title="مالی"
        subtitle="درآمد شما از رزروهای پرداخت‌شده، پس از کسر کارمزد پلتفرم."
        action={
          // With one workspace the badge names it, exactly as before. With two,
          // the selector below is the control and a second static label would
          // only compete with it.
          !multiple && active ? (
            <Badge tone={active.workspaceType === 'business' ? 'primary' : 'neutral'}>
              {active.workspaceType === 'business' ? 'درآمد به حساب کسب‌وکار' : 'درآمد شخصی'}
            </Badge>
          ) : undefined
        }
      />

      {multiple ? (
        <div style={{ marginBlockEnd: 20 }}>
          {/*
            A labelled group of `aria-pressed` toggle buttons — the repository's
            existing control, reused rather than reinvented. It is deliberately
            not a tablist: that role promises arrow-key traversal this does not
            implement.

            The label names the choice rather than the workspaces, because a
            workspace's own name is not something this API returns and inventing
            one would put a fictional salon on a money screen.
          */}
          <SegmentedControl
            label="انتخاب کسب‌وکار"
            value={activeRef ?? ''}
            options={workspaces.map((workspace) => ({
              value: workspace.workspaceRef,
              label: WORKSPACE_LABEL[workspace.workspaceType],
            }))}
            onChange={selectWorkspace}
            disabled={loading}
          />
        </div>
      ) : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری اطلاعات مالی…" />
      ) : (
        <>
          {summary ? (
            <div style={{ marginBlockEnd: 20 }}>
              <StatGrid>
                <StatCard label="خالص قابل دریافت" value={formatToman(summary.receivableNetToman)} />
                <StatCard label="تسویه‌شده" value={formatToman(summary.settledToman)} />
                <StatCard label="در انتظار تسویه" value={formatToman(summary.outstandingToman)} />
              </StatGrid>
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
      )}
    </>
  );
}
