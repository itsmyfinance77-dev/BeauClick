'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import { PriceDisplay } from './price-display';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, DataCell, DataRow, DataTable, EmptyState, PageHeader, StatCard, StatGrid } from '@/components/kit';
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
import {
  ACCESS_MODE_LABEL,
  WORKSPACE_TYPE_LABEL,
  ledgerEntryLabel,
  settlementKindLabel,
  settlementKindTone,
} from '@/lib/finance-labels';
import styles from './finance-workspace.module.css';

const SETTLEMENTS_HEADING_ID = 'finance-settlements-heading';
const SETTLEMENT_HEAD = ['تاریخ', 'مبلغ', 'روش', 'نوع'] as const;

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
    <span className={styles.mark}>
      <span aria-hidden="true" className={`${styles.markShape} ${mode === 'owner' ? styles.markOwner : styles.markRead}`} />
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
        <fieldset aria-labelledby={fieldsetLegendId} className={styles.selector}>
          <legend id={fieldsetLegendId} className={styles.selectorLegend}>
            کدام فضای مالی؟
          </legend>
          <p className={styles.selectorLead}>
            هیچ فضایی خودبه‌خود انتخاب نمی‌شود. تا وقتی یکی را انتخاب نکنید، هیچ رقمی نمایش داده نمی‌شود.
          </p>
          <div className={styles.choices}>
            {list.map((workspace) => {
              const checked = workspace.workspaceRef === active?.workspaceRef;
              return (
                <label key={workspace.workspaceRef} className={`${styles.choice} ${checked ? styles.choiceOn : ''}`}>
                  <input
                    type="radio"
                    name="finance-workspace"
                    checked={checked}
                    onChange={() => selectWorkspace(workspace.workspaceRef)}
                  />
                  <span className={styles.choiceText}>
                    <span className={styles.choiceLabel}>{workspace.displayLabel}</span>
                    <span className={styles.choiceMeta}>
                      <span className={styles.choiceType}>{WORKSPACE_TYPE_LABEL[workspace.workspaceType]}</span>
                      <AccessModeMark mode={workspace.accessMode} />
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : active ? (
        <div className={styles.single}>
          <Badge tone={active.workspaceType === 'business' ? 'primary' : 'neutral'}>{active.displayLabel}</Badge>
          <AccessModeMark mode={active.accessMode} />
        </div>
      ) : null}

      {active ? (
        <>
          {active.accessMode === 'finance_read' ? (
            <div className={styles.readOnly}>
              <span aria-hidden="true" className={styles.readOnlyShape} />
              <span className={styles.readOnlyTitle}>شما این فضا را فقط می‌خوانید</span>
              <span className={styles.readOnlyText}>
                هیچ تغییری در تسویه، پرداخت، بازگشت وجه یا دفتر مالی از اینجا ممکن نیست.
              </span>
            </div>
          ) : null}

          <h2 className={styles.legacyTitle}>ارقامِ سامانهٔ پیشین</h2>
          {summaryLoading ? (
            <LoadingState label="در حال بارگذاری خلاصهٔ مالی…" lines={2} />
          ) : summaryError ? (
            <ErrorState message={summaryError} onRetry={() => void loadSummary(active.workspaceRef)} />
          ) : summary ? (
            <div className={styles.section}>
              <StatGrid min={180}>
                <StatCard label="خالص قابل دریافت" value={<PriceDisplay amount={summary.receivableNetToman} />} />
                <StatCard label="تسویه‌شده" value={<PriceDisplay amount={summary.settledToman} />} />
                <StatCard label="در انتظار تسویه" value={<PriceDisplay amount={summary.outstandingToman} />} />
              </StatGrid>
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
            <LoadingState label="در حال بارگذاری وجوه…" lines={2} />
          ) : funds ? (
            <FundsByState funds={funds} />
          ) : null}

          <h2 className={styles.sectionTitle}>سفارش‌های در انتظار تسویه</h2>
          {ordersLoading || ordersLoadedFor !== active.workspaceRef ? (
            <LoadingState label="در حال بارگذاری سفارش‌ها…" lines={3} />
          ) : ordersError ? (
            <ErrorState message={ordersError} onRetry={() => void loadOrders(active.workspaceRef)} />
          ) : orders.length === 0 ? (
            <EmptyState message="سفارشی در انتظار تسویه ندارید." />
          ) : (
            <ul className={styles.orders}>
              {orders.map((order) => (
                <li key={order.orderId} className={`${styles.panel} ${styles.order}`} data-order={order.orderId}>
                  <div className={styles.orderText}>
                    <p className={styles.orderAmount}><PriceDisplay amount={order.outstandingToman} /></p>
                    <p className={styles.orderRef}>
                      سفارش <span className={styles.ref}>{order.orderId.slice(0, 8)}</span>
                    </p>
                  </div>
                  <Button type="button" variant="ghost" inline onClick={() => void toggleLedger(order.orderId)}>
                    {ledgerFor === order.orderId ? 'بستن ریز تراکنش' : 'ریز تراکنش'}
                  </Button>

                  {ledgerFor === order.orderId ? (
                    <div className={styles.ledger}>
                      {ledgerLoading ? (
                        <LoadingState label="در حال بارگذاری ریز تراکنش…" lines={2} />
                      ) : ledgerError ? (
                        <ErrorState message={ledgerError} onRetry={() => void toggleLedger(order.orderId)} />
                      ) : ledger.length === 0 ? (
                        <p className={styles.ledgerEmpty}>تراکنشی برای این سفارش ثبت نشده است.</p>
                      ) : (
                        <>
                          <p id={`ledger-heading-${order.orderId}`} className={styles.ledgerCaption}>
                            ریز تراکنش سفارش
                          </p>
                          <DataTable head={['ردیف', 'مبلغ', 'نرخ']} aria-labelledby={`ledger-heading-${order.orderId}`}>
                            {ledger.map((entry) => (
                              <DataRow key={entry.id}>
                                <DataCell label="ردیف">{ledgerEntryLabel(entry.entryType)}</DataCell>
                                <DataCell label="مبلغ">
                                  <PriceDisplay amount={entry.amountToman} />
                                </DataCell>
                                <DataCell label="نرخ">
                                  <span className={styles.ledgerRate}>
                                    {toPersianDigits((entry.commissionRateBp / 100).toFixed(1))}٪
                                  </span>
                                </DataCell>
                              </DataRow>
                            ))}
                          </DataTable>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <h2 id={SETTLEMENTS_HEADING_ID} className={styles.sectionTitleSpaced}>
            تاریخچه تسویه
          </h2>
          {settlementsLoading || settlementsLoadedFor !== active.workspaceRef ? (
            <LoadingState label="در حال بارگذاری تاریخچهٔ تسویه…" lines={3} />
          ) : settlementsError ? (
            <ErrorState message={settlementsError} onRetry={() => void loadSettlements(active.workspaceRef)} />
          ) : batches.length === 0 ? (
            <EmptyState message="هنوز تسویه‌ای انجام نشده است." />
          ) : (
            <>
              {/* A real table from 1024, a card list below 640 (`DataTable`): "wide
                  tables become labelled card rows, never horizontally scrolling
                  financial tables" (the responsive handoff, §6). */}
              <DataTable head={SETTLEMENT_HEAD} aria-labelledby={SETTLEMENTS_HEADING_ID}>
                {batches.map((batch) => (
                  <DataRow key={batch.id} data-settlement={batch.id}>
                    <DataCell label="تاریخ">{formatZonedFullDate(new Date(batch.createdAt))}</DataCell>
                    <DataCell label="مبلغ">
                      <span className={styles.amount}><PriceDisplay amount={batch.amountToman} /></span>
                    </DataCell>
                    <DataCell label="روش">
                      {batch.method ? <span className={styles.method}>{batch.method}</span> : '—'}
                    </DataCell>
                    <DataCell label="نوع">
                      <Badge tone={settlementKindTone(batch.kind)}>{settlementKindLabel(batch.kind)}</Badge>
                    </DataCell>
                  </DataRow>
                ))}
              </DataTable>
              {nextCursor ? (
                <div className={styles.more}>
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
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </>
  );
}
