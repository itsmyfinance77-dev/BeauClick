'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatToman, formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import { Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader } from '@/components/kit';
import { FundsByState } from '@/components/funds-by-state';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import {
  financeSummary,
  financeWorkspaces,
  orderLedger,
  outstandingOrders,
  settlements,
  workspaceFunds,
  type FinanceAccessMode,
  type FinanceSummary,
  type FinanceWorkspace,
  type LedgerEntry,
  type OutstandingOrder,
  type SettlementBatch,
  type WorkspaceFunds,
} from '@/lib/pro-api';

/**
 * The persona-neutral finance surface -- V3.3 Story #152 (`#149b`), shared by
 * the new `/finance` route and the legacy `/pro/finance` compatibility entry
 * point. One component, one finance-rendering path, so the two routes cannot
 * quietly drift apart.
 *
 * ## Why selection is never automatic
 *
 * `V33-DEC-020` forbids picking `items[0]` for the caller: a dual owner (or an
 * owner who also holds a `finance_read` grant elsewhere) has no honest default
 * workspace, and silently choosing one would show the wrong money under the
 * right chrome. With exactly one reachable workspace there is nothing to
 * choose between, so that one opens directly; with two or more, nothing is
 * shown until the caller picks.
 *
 * ## Why a refusal clears the workspace rather than retrying it
 *
 * The five workspace-aware routes answer every failure -- revoked grant,
 * deactivated membership, deleted business, stale reference -- with the same
 * non-enumerating refusal. There is no cause worth distinguishing, so the
 * response here is identical for all of them: clear whatever was rendered,
 * drop that workspace out of the addressable set, and return to the
 * remaining ones (or the empty state) rather than retry a reference that will
 * never resolve again.
 */

const WORKSPACE_TYPE_LABEL: Record<FinanceWorkspace['workspaceType'], string> = {
  professional: 'تخصصی',
  business: 'کسب‌وکار',
};

const ACCESS_MODE_LABEL: Record<FinanceAccessMode, string> = {
  owner: 'دسترسیِ مالکانه',
  finance_read: 'دسترسیِ فقط‌خواندنیِ واگذارشده',
};

function isRecoverableRefusal(err: unknown): boolean {
  // 404: the server's single non-enumerating refusal for every workspace-aware
  // read. 409 would be `finance_workspace_selection_required`, which only the
  // legacy singular routes can raise -- this surface never calls them, but a
  // 409 arriving here anyway is treated the same way rather than crashing: it
  // means "open the selector", not "show an error".
  return err instanceof ApiRequestError && (err.status === 404 || err.status === 409);
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Shape as well as colour: a filled circle for owner, a hollow square for a delegated read-only grant. */
function AccessModeMark({ mode }: { mode: FinanceAccessMode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
      <span
        aria-hidden="true"
        style={
          mode === 'owner'
            ? { width: 9, height: 9, borderRadius: 999, background: 'var(--bc-color-primary)', flexShrink: 0 }
            : { width: 9, height: 9, borderRadius: 2, border: '2px solid var(--bc-color-ink-soft)', flexShrink: 0 }
        }
      />
      {ACCESS_MODE_LABEL[mode]}
    </span>
  );
}

export function FinanceWorkspaceSurface() {
  const { api } = useAuth();
  const fieldsetLegendId = useId();

  const [workspaces, setWorkspaces] = useState<FinanceWorkspace[] | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  const [activeRef, setActiveRef] = useState<string | null>(null);

  /**
   * Three INDEPENDENT sections, each with its own loading/error state --
   * screen 46 §4's "partial-section failure": one section failing (a ledger
   * service hiccup) must never blank the others, and each retries on its own.
   */
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  /**
   * V3.3 `#43a` / #185. A FOURTH independent section, under the same rule as
   * the three above: this read failing must not blank the others, and it
   * retries on its own. `fundsLoadedFor` mirrors `ordersLoadedFor` -- until it
   * matches the active workspace the section is loading, never "all zero",
   * which would be a claim about a request that has not been answered.
   */
  const [funds, setFunds] = useState<WorkspaceFunds | null>(null);
  const [fundsLoading, setFundsLoading] = useState(false);
  const [fundsError, setFundsError] = useState<string | null>(null);
  const [fundsLoadedFor, setFundsLoadedFor] = useState<string | null>(null);

  const [orders, setOrders] = useState<OutstandingOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  // The workspace the orders on screen were actually loaded for. Until it
  // matches the active one the section is loading -- never "no orders", which
  // would be a claim about a request that has not been answered (or sent).
  const [ordersLoadedFor, setOrdersLoadedFor] = useState<string | null>(null);

  const [batches, setBatches] = useState<SettlementBatch[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [settlementsLoading, setSettlementsLoading] = useState(false);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  // Same rule as `ordersLoadedFor`, for the settlement history.
  const [settlementsLoadedFor, setSettlementsLoadedFor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  // Dedupes a workspace-loss reaction when more than one section's request
  // returns the refusal for the same selection.
  const authorityLossHandledForRef = useRef<string | null>(null);

  const clearContent = useCallback(() => {
    setSummary(null);
    setSummaryError(null);
    setFunds(null);
    setFundsError(null);
    setFundsLoadedFor(null);
    setOrders([]);
    setOrdersError(null);
    setOrdersLoadedFor(null);
    setBatches([]);
    setNextCursor(null);
    setSettlementsError(null);
    setSettlementsLoadedFor(null);
    setLedgerFor(null);
    setLedger([]);
    setLedgerError(null);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setWorkspacesError(null);
    try {
      const res = await financeWorkspaces(api);
      const items = res.data?.items ?? [];
      setWorkspaces(items);
      setActiveRef((current) => {
        if (current && items.some((workspace) => workspace.workspaceRef === current)) return current;
        // A group of one is a puzzle, not a choice -- it opens directly. Two
        // or more require an explicit pick; nothing is preselected for them.
        return items.length === 1 ? items[0].workspaceRef : null;
      });
    } catch (err) {
      setWorkspacesError(errorMessage(err, 'فهرست فضاهای مالی بارگذاری نشد.'));
    } finally {
      setWorkspacesLoading(false);
    }
  }, [api]);

  /**
   * The workspace stopped being reachable (revoked grant, deactivated
   * membership, deleted business, stale reference) -- one reaction for every
   * cause: clear whatever was rendered, drop it from the addressable set, and
   * return to the remaining workspaces. Guarded so the three sections calling
   * it for the same selection only act once.
   */
  const handleAuthorityLoss = useCallback(
    (workspaceRef: string) => {
      if (authorityLossHandledForRef.current === workspaceRef) return;
      authorityLossHandledForRef.current = workspaceRef;
      clearContent();
      setActiveRef(null);
      setWorkspaces((current) => (current ?? []).filter((workspace) => workspace.workspaceRef !== workspaceRef));
      void loadWorkspaces();
    },
    [clearContent, loadWorkspaces],
  );

  const loadSummary = useCallback(
    async (workspaceRef: string) => {
      setSummaryLoading(true);
      setSummaryError(null);
      try {
        const res = await financeSummary(api, workspaceRef);
        setSummary(res.data ?? null);
      } catch (err) {
        if (isRecoverableRefusal(err)) {
          handleAuthorityLoss(workspaceRef);
          return;
        }
        setSummaryError(errorMessage(err, 'خلاصهٔ مالی بارگذاری نشد.'));
      } finally {
        setSummaryLoading(false);
      }
    },
    [api, handleAuthorityLoss],
  );

  const loadFunds = useCallback(
    async (workspaceRef: string) => {
      setFundsLoading(true);
      setFundsError(null);
      try {
        const res = await workspaceFunds(api, workspaceRef);
        setFunds(res.data ?? null);
        setFundsLoadedFor(workspaceRef);
      } catch (err) {
        if (isRecoverableRefusal(err)) {
          handleAuthorityLoss(workspaceRef);
          return;
        }
        setFundsError(errorMessage(err, 'وجوهِ این فضا بارگذاری نشد.'));
      } finally {
        setFundsLoading(false);
      }
    },
    [api, handleAuthorityLoss],
  );

  const loadOrders = useCallback(
    async (workspaceRef: string) => {
      setOrdersLoading(true);
      setOrdersError(null);
      try {
        const res = await outstandingOrders(api, workspaceRef);
        setOrders(res.data ?? []);
      } catch (err) {
        if (isRecoverableRefusal(err)) {
          handleAuthorityLoss(workspaceRef);
          return;
        }
        setOrdersError(errorMessage(err, 'سفارش‌های در انتظار تسویه بارگذاری نشد.'));
      } finally {
        setOrdersLoading(false);
        setOrdersLoadedFor(workspaceRef);
      }
    },
    [api, handleAuthorityLoss],
  );

  const loadSettlements = useCallback(
    async (workspaceRef: string) => {
      setSettlementsLoading(true);
      setSettlementsError(null);
      try {
        const res = await settlements(api, workspaceRef);
        setBatches(res.data?.items ?? []);
        setNextCursor(res.data?.nextCursor ?? null);
      } catch (err) {
        if (isRecoverableRefusal(err)) {
          handleAuthorityLoss(workspaceRef);
          return;
        }
        setSettlementsError(errorMessage(err, 'تاریخچهٔ تسویه بارگذاری نشد.'));
      } finally {
        setSettlementsLoading(false);
        setSettlementsLoadedFor(workspaceRef);
      }
    },
    [api, handleAuthorityLoss],
  );

  useEffect(() => {
    void loadWorkspaces();
    // Runs once on mount only -- `loadWorkspaces` is re-created per render via
    // `useCallback([api])`, and re-running it on every such change would
    // refetch the list on every keystroke elsewhere in the app.
  }, []);

  useEffect(() => {
    if (!activeRef) return;
    authorityLossHandledForRef.current = null;
    // Independent calls, not `Promise.all` -- one section's rejection must
    // never keep the others from ever settling.
    void loadSummary(activeRef);
    void loadFunds(activeRef);
    void loadOrders(activeRef);
    void loadSettlements(activeRef);
  }, [activeRef]);

  function selectWorkspace(workspaceRef: string) {
    if (workspaceRef === activeRef) return;
    // Clears BEFORE the next request starts -- otherwise a slow response
    // would leave one workspace's figures rendered under another's selection.
    clearContent();
    setActiveRef(workspaceRef);
  }

  async function loadMoreSettlements() {
    if (!activeRef || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await settlements(api, activeRef, { cursor: nextCursor });
      setBatches((current) => [...current, ...(res.data?.items ?? [])]);
      setNextCursor(res.data?.nextCursor ?? null);
    } catch (err) {
      if (isRecoverableRefusal(err)) {
        handleAuthorityLoss(activeRef);
        return;
      }
      setSettlementsError(errorMessage(err, 'صفحهٔ بعدِ تسویه بارگذاری نشد.'));
    } finally {
      setLoadingMore(false);
    }
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
      setLedgerError(errorMessage(err, 'ریز تراکنش بارگذاری نشد.'));
    } finally {
      setLedgerLoading(false);
    }
  }

  if (workspacesLoading && workspaces === null) {
    return <LoadingState label="در حال بارگذاری فضاهای مالی…" />;
  }
  if (workspacesError) {
    return <ErrorState message={workspacesError} onRetry={() => void loadWorkspaces()} />;
  }

  const list = workspaces ?? [];

  // Owning/reaching no finance workspace is a legitimate state, not a failure.
  if (list.length === 0) {
    return (
      <>
        <PageHeader title="امور مالی" subtitle="خلاصهٔ مالی، سفارش‌های در انتظار تسویه و تاریخچهٔ تسویهٔ هر فضای مالی که به آن دسترسی دارید." />
        <EmptyState message="در حال حاضر دسترسیِ مالی‌ای ندارید." />
      </>
    );
  }

  const active = list.find((workspace) => workspace.workspaceRef === activeRef) ?? null;
  const multiple = list.length > 1;

  return (
    <>
      <PageHeader title="امور مالی" subtitle="خلاصهٔ مالی، سفارش‌های در انتظار تسویه و تاریخچهٔ تسویهٔ فضای انتخاب‌شده." />

      {multiple ? (
        <fieldset
          aria-labelledby={fieldsetLegendId}
          style={{
            margin: '0 0 20px',
            border: '1px solid var(--bc-color-line)',
            borderRadius: 'var(--bc-radius-card)',
            padding: '16px 18px',
          }}
        >
          <legend id={fieldsetLegendId} style={{ padding: '0 6px', fontSize: 14, fontWeight: 800 }}>
            کدام فضای مالی؟
          </legend>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--bc-color-ink-soft)' }}>
            هیچ فضایی خودبه‌خود انتخاب نمی‌شود. تا وقتی یکی را انتخاب نکنید، هیچ رقمی نمایش داده نمی‌شود.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {list.map((workspace) => {
              const checked = workspace.workspaceRef === active?.workspaceRef;
              return (
                <label
                  key={workspace.workspaceRef}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    minHeight: 44,
                    padding: '12px 14px',
                    borderRadius: 'var(--bc-radius-row)',
                    border: `1px solid ${checked ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
                    background: checked ? 'var(--bc-color-primary-soft)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="finance-workspace"
                    checked={checked}
                    onChange={() => selectWorkspace(workspace.workspaceRef)}
                    style={{ marginTop: 3, width: 20, height: 20, flexShrink: 0 }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, overflowWrap: 'anywhere' }}>{workspace.displayLabel}</span>
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--bc-color-ink-soft)' }}>
                        {WORKSPACE_TYPE_LABEL[workspace.workspaceType]}
                      </span>
                      <AccessModeMark mode={workspace.accessMode} />
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : active ? (
        <div style={{ marginBlockEnd: 20, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone={active.workspaceType === 'business' ? 'primary' : 'neutral'}>{active.displayLabel}</Badge>
          <AccessModeMark mode={active.accessMode} />
        </div>
      ) : null}

      {active ? (
        <>
          {active.accessMode === 'finance_read' ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '12px 16px',
                marginBlockEnd: 16,
                borderRadius: 'var(--bc-radius-row)',
                background: 'var(--bc-color-surface-tint)',
                border: '1px solid var(--bc-color-line)',
              }}
            >
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, border: '2px solid var(--bc-color-ink-soft)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700 }}>شما این فضا را فقط می‌خوانید</span>
              <span style={{ fontSize: 12.5, color: 'var(--bc-color-ink-soft)' }}>
                هیچ تغییری در تسویه، پرداخت، بازگشت وجه یا دفتر مالی از اینجا ممکن نیست.
              </span>
            </div>
          ) : null}

          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>ارقامِ سامانهٔ پیشین</h2>
          {summaryLoading ? (
            <LoadingState label="در حال بارگذاری خلاصهٔ مالی…" />
          ) : summaryError ? (
            <ErrorState message={summaryError} onRetry={() => void loadSummary(active.workspaceRef)} />
          ) : summary ? (
            <div style={{ marginBlockEnd: 20, display: 'grid', gap: 'var(--bc-spacing-card-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              <Card>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>خالص قابل دریافت</p>
                <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{formatToman(summary.receivableNetToman)}</p>
              </Card>
              <Card>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>تسویه‌شده</p>
                <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{formatToman(summary.settledToman)}</p>
              </Card>
              <Card>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>در انتظار تسویه</p>
                <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{formatToman(summary.outstandingToman)}</p>
              </Card>
            </div>
          ) : null}

          {/*
            V3.3 `#43a` / #185. Its own loading and error state, scoped to this
            section: a funds read that fails leaves the legacy figures, the
            orders and the settlement history exactly where they are.
          */}
          {fundsError ? (
            <ErrorState message={fundsError} onRetry={() => void loadFunds(active.workspaceRef)} />
          ) : fundsLoading || fundsLoadedFor !== active.workspaceRef ? (
            <LoadingState label="در حال بارگذاری وجوه…" />
          ) : funds ? (
            <FundsByState funds={funds} />
          ) : null}

          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>سفارش‌های در انتظار تسویه</h2>
          {ordersLoading || ordersLoadedFor !== active.workspaceRef ? (
            <LoadingState label="در حال بارگذاری سفارش‌ها…" />
          ) : ordersError ? (
            <ErrorState message={ordersError} onRetry={() => void loadOrders(active.workspaceRef)} />
          ) : orders.length === 0 ? (
            <EmptyState message="سفارشی در انتظار تسویه ندارید." />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
              {orders.map((order) => (
                    <Card key={order.orderId}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--bc-spacing-chip-gap)' }}>
                        <div style={{ minWidth: 0 }}>
                          <p style={{ margin: 0, fontWeight: 700 }}>{formatToman(order.outstandingToman)}</p>
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
                        <div style={{ marginBlockStart: 16, paddingBlockStart: 16, borderBlockStart: '1px solid var(--bc-color-line)' }}>
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
              {settlementsLoading || settlementsLoadedFor !== active.workspaceRef ? (
                <LoadingState label="در حال بارگذاری تاریخچهٔ تسویه…" />
              ) : settlementsError ? (
                <ErrorState message={settlementsError} onRetry={() => void loadSettlements(active.workspaceRef)} />
              ) : batches.length === 0 ? (
                <EmptyState message="هنوز تسویه‌ای انجام نشده است." />
              ) : (
                <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
                  {batches.map((batch) => (
                    <Card key={batch.id}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--bc-spacing-chip-gap)' }}>
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
                  {nextCursor ? (
                    <Button
                      type="button"
                      variant="ghost"
                      inline
                      busy={loadingMore}
                      disabled={loadingMore}
                      onClick={() => void loadMoreSettlements()}
                    >
                      {loadingMore ? 'در حال بارگذاری…' : 'صفحهٔ بعد'}
                    </Button>
                  ) : null}
                </div>
              )}
        </>
      ) : null}
    </>
  );
}
