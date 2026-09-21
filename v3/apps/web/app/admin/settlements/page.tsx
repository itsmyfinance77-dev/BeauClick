'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, Input, LoadingState } from '@/components/ui';
import {
  ConfirmDialog,
  DataCell,
  DataRow,
  DataTable,
  EmptyState,
  PageHeader,
  Select,
  StatCard,
  StatGrid,
  Textarea,
} from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { partyTypeLabel } from '@/lib/admin-labels';
import {
  createSettlement,
  partyOutstandingOrders,
  partySummary,
  platformTotals,
  type PartyOutstandingOrder,
  type PartySummary,
  type PlatformTotals,
} from '@/lib/admin-api';
import styles from './settlements.module.css';

type PartyType = 'professional' | 'business';

/** The party a lookup was made for. A settlement is recorded against THIS, never against whatever the form says now. */
interface LookedUpParty {
  type: PartyType;
  id: string;
}

const ORDERS_HEADING_ID = 'settlement-orders-heading';
const ORDERS_HEAD = ['انتخاب', 'شمارهٔ سفارش', 'مبلغ در انتظار'] as const;
const SUMMARY_DESCRIPTION_ID = 'settlement-confirm-summary';

/**
 * Settlement — paying a seller what they are owed.
 *
 * Until Phase A this was unreachable: the routes existed, and
 * `bc_manage_platform` could not be granted to any account (R31-01), so no
 * professional could ever be paid through the product.
 *
 * TWO THINGS THIS SCREEN DOES NOT DO, both deliberate:
 *
 *  - It does not move money. `financial.settlement_batches` RECORDS that a
 *    payout was made; the payment itself happens through whatever banking rail
 *    the business uses. Automated disbursement is GAP-18 and out of scope.
 *  - It does not offer reversal from a list. Reversal exists on the API and is
 *    genuinely dangerous; wiring it to a button next to every row is how it
 *    gets clicked by accident. It is deliberately absent here until there is a
 *    settlement-history screen with the context to justify it.
 *
 * THE PARTY IS FIXED AT LOOKUP. The form stays on screen after a lookup, so an
 * operator can retype the id or flip the type while a party's orders are still
 * listed. The settlement — and the refresh after it — is therefore recorded
 * against the party that was LOOKED UP (`looked`), and the confirmation names
 * that party, not whatever the fields say by then. Before this, editing the id
 * after a lookup and pressing «ثبت تسویه» sent the first party's order ids
 * against the second party's id.
 */
export default function AdminSettlementsPage() {
  const { api } = useAuth();

  const [totals, setTotals] = useState<PlatformTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [partyType, setPartyType] = useState<PartyType>('professional');
  const [partyId, setPartyId] = useState('');
  const [looked, setLooked] = useState<LookedUpParty | null>(null);
  const [summary, setSummary] = useState<PartySummary | null>(null);
  const [orders, setOrders] = useState<PartyOutstandingOrder[]>([]);
  const [lookingUp, setLookingUp] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await platformTotals(api);
      setTotals(res.data ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'اطلاعات مالی پلتفرم بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    const id = partyId.trim();
    setError(null);
    setSuccess(null);
    if (!id) {
      setError('شناسهٔ متخصص یا کسب‌وکار را وارد کنید.');
      return;
    }
    setLookingUp(true);
    setLooked(null);
    setSelected([]);
    try {
      const [summaryRes, ordersRes] = await Promise.all([
        partySummary(api, partyType, id),
        partyOutstandingOrders(api, partyType, id),
      ]);
      setSummary(summaryRes.data ?? null);
      setOrders(ordersRes.data ?? []);
      setLooked({ type: partyType, id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات این طرف حساب بارگذاری نشد.');
    } finally {
      setLookingUp(false);
    }
  }

  async function refresh(party: LookedUpParty) {
    try {
      const [summaryRes, ordersRes] = await Promise.all([
        partySummary(api, party.type, party.id),
        partyOutstandingOrders(api, party.type, party.id),
      ]);
      setSummary(summaryRes.data ?? null);
      setOrders(ordersRes.data ?? []);
    } catch {
      // The settlement already succeeded; a failed refresh must not be reported
      // as a failed settlement.
    }
  }

  async function confirm() {
    if (!looked) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await createSettlement(api, {
        partyType: looked.type,
        partyId: looked.id,
        orderIds: selected,
        method: method.trim() || undefined,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setSuccess(`تسویه به مبلغ ${formatToman(res.data?.amountToman ?? 0)} ثبت شد.`);
      setPending(false);
      setSelected([]);
      setMethod('');
      setReference('');
      setNote('');
      // Re-read: settling changes both the party's outstanding orders and the
      // platform totals, and the server's figures are the ones that matter.
      await Promise.all([load(), refresh(looked)]);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'ثبت تسویه انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(orderId: string) {
    setSelected((current) => (current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId]));
  }

  const selectedTotal = orders
    .filter((o) => selected.includes(o.orderId))
    .reduce((sum, o) => sum + o.outstandingToman, 0);

  return (
    <div className={styles.page}>
      <PageHeader title="تسویه‌ها" subtitle="ثبت پرداخت به متخصص‌ها و کسب‌وکارها." />

      {error ? <Alert>{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      {loading && !totals ? (
        <LoadingState label="در حال بارگذاری…" lines={3} />
      ) : loadError && !totals ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : totals ? (
        <StatGrid>
          <StatCard label="کارمزد پلتفرم" value={formatToman(totals.commissionToman)} />
          <StatCard label="سهم فروشندگان" value={formatToman(totals.receivableToman)} />
          <StatCard label="سفارش‌های پرداخت‌شده" value={toPersianDigits(totals.orderCount)} />
        </StatGrid>
      ) : null}

      <section className={styles.panel} aria-labelledby="settlement-lookup-heading">
        <h2 id="settlement-lookup-heading" className={styles.sectionTitle}>
          یافتن طرف حساب
        </h2>
        <form onSubmit={lookup} noValidate>
          <Select label="نوع" value={partyType} onChange={(e) => setPartyType(e.target.value as PartyType)}>
            <option value="professional">{partyTypeLabel('professional')}</option>
            <option value="business">{partyTypeLabel('business')}</option>
          </Select>
          <Input
            label="شناسه"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required
            hint="شناسه متخصص یا کسب‌وکار. از صفحه صف احراز هویت یا گزارش عملیات قابل کپی است."
          />
          <Button type="submit" loading={lookingUp}>
            نمایش وضعیت
          </Button>
        </form>
      </section>

      {looked ? (
        <>
          {summary ? (
            <section className={styles.panel} aria-labelledby="settlement-party-heading">
              <h2 id="settlement-party-heading" className={styles.sectionTitle}>
                وضعیت مالی طرف حساب
              </h2>
              <p className={styles.party}>
                <span>{partyTypeLabel(looked.type)}</span>
                <span className={styles.partyId}>{looked.id}</span>
              </p>
              <dl className={styles.figures}>
                <div className={`${styles.figure} ${styles.figureStrong}`}>
                  <dt>خالص قابل پرداخت</dt>
                  <dd>{formatToman(summary.receivableNetToman)}</dd>
                </div>
                <div className={styles.figure}>
                  <dt>تسویه‌شده تاکنون</dt>
                  <dd>{formatToman(summary.settledToman)}</dd>
                </div>
                <div className={`${styles.figure} ${styles.figureStrong}`}>
                  <dt>در انتظار تسویه</dt>
                  <dd>{formatToman(summary.outstandingToman)}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          <section className={styles.panel} aria-labelledby={ORDERS_HEADING_ID}>
            <h2 id={ORDERS_HEADING_ID} className={styles.sectionTitle}>
              سفارش‌های در انتظار تسویه
            </h2>
            {orders.length === 0 ? (
              <EmptyState message="سفارشی در انتظار تسویه برای این طرف حساب وجود ندارد." />
            ) : (
              /* A real table on wide screens, one card per order below 640
                 (`DataTable`), with a native checkbox per row. */
              <DataTable head={ORDERS_HEAD} aria-labelledby={ORDERS_HEADING_ID}>
                {orders.map((order) => {
                  const checked = selected.includes(order.orderId);
                  const short = order.orderId.slice(0, 8);
                  return (
                    <DataRow key={order.orderId} data-order={order.orderId} className={checked ? styles.selectedRow : undefined}>
                      <DataCell label="انتخاب">
                        <label className={styles.pick}>
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={`انتخاب سفارش ${short}`}
                            onChange={() => toggle(order.orderId)}
                          />
                        </label>
                      </DataCell>
                      <DataCell label="شمارهٔ سفارش">
                        <span className={styles.orderId} title={order.orderId}>
                          {short}
                        </span>
                      </DataCell>
                      <DataCell label="مبلغ در انتظار">
                        <span className={styles.amount}>{formatToman(order.outstandingToman)}</span>
                      </DataCell>
                    </DataRow>
                  );
                })}
              </DataTable>
            )}
          </section>

          {orders.length > 0 ? (
            <section className={`${styles.panel} ${styles.settle}`} aria-labelledby="settlement-record-heading">
              <h2 id="settlement-record-heading" className={styles.settleTitle}>
                ثبت تسویه
              </h2>
              <p className={styles.note}>
                این کار پرداخت را <strong>ثبت</strong> می‌کند؛ انتقال وجه جداگانه و خارج از سامانه انجام می‌شود.
              </p>
              <Input label="روش پرداخت" value={method} onChange={(e) => setMethod(e.target.value)} hint="مثلاً: انتقال بانکی" />
              <Input
                label="شماره پیگیری"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                hint="شماره پیگیری تراکنش بانکی، برای مطابقت بعدی."
              />
              <Textarea label="توضیح" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              <p className={styles.total} role="status">
                مبلغ انتخاب‌شده: <strong>{formatToman(selectedTotal)}</strong> ({toPersianDigits(selected.length)} سفارش)
              </p>
              <Button type="button" disabled={selected.length === 0} onClick={() => setPending(true)}>
                ثبت تسویه
              </Button>
            </section>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pending}
        title="ثبت تسویه"
        confirmLabel="ثبت کن"
        busy={busy}
        describedById={SUMMARY_DESCRIPTION_ID}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(false)}
        body={
          <div id={SUMMARY_DESCRIPTION_ID} className={styles.dialogBody}>
            <p className={styles.dialogText}>
              تسویه {formatToman(selectedTotal)} برای {toPersianDigits(selected.length)} سفارشِ {looked ? partyTypeLabel(looked.type) : ''}{' '}
              <span className={styles.partyId}>{looked?.id}</span> ثبت می‌شود.
            </p>
            <p className={styles.dialogWarning}>
              دفتر مالی فقط قابل افزودن است؛ این رکورد قابل حذف نیست و برگشت آن نیازمند عملیات جداگانه است.
            </p>
          </div>
        }
      />
    </div>
  );
}
