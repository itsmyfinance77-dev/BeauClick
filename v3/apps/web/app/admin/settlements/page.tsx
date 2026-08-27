'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, Input, LoadingState } from '@/components/ui';
import { ConfirmDialog, EmptyState, PageHeader, Select, Textarea } from '@/components/pro-ui';
import { useAuth } from '@/lib/auth-context';
import {
  createSettlement,
  partyOutstandingOrders,
  partySummary,
  platformTotals,
  type PartyOutstandingOrder,
  type PartySummary,
  type PlatformTotals,
} from '@/lib/admin-api';

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
 */
export default function AdminSettlementsPage() {
  const { api } = useAuth();

  const [totals, setTotals] = useState<PlatformTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [partyType, setPartyType] = useState<'professional' | 'business'>('professional');
  const [partyId, setPartyId] = useState('');
  const [summary, setSummary] = useState<PartySummary | null>(null);
  const [orders, setOrders] = useState<PartyOutstandingOrder[]>([]);
  const [lookedUp, setLookedUp] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await platformTotals(api);
      setTotals(res.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات مالی پلتفرم بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setLookingUp(true);
    setError(null);
    setSuccess(null);
    setLookedUp(false);
    setSelected([]);
    try {
      const id = partyId.trim();
      const [summaryRes, ordersRes] = await Promise.all([
        partySummary(api, partyType, id),
        partyOutstandingOrders(api, partyType, id),
      ]);
      setSummary(summaryRes.data ?? null);
      setOrders(ordersRes.data ?? []);
      setLookedUp(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات این طرف حساب بارگذاری نشد.');
    } finally {
      setLookingUp(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await createSettlement(api, {
        partyType,
        partyId: partyId.trim(),
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
      await Promise.all([load(), lookupSilently()]);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'ثبت تسویه انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  async function lookupSilently() {
    try {
      const id = partyId.trim();
      const [summaryRes, ordersRes] = await Promise.all([
        partySummary(api, partyType, id),
        partyOutstandingOrders(api, partyType, id),
      ]);
      setSummary(summaryRes.data ?? null);
      setOrders(ordersRes.data ?? []);
    } catch {
      // The settlement already succeeded; a failed refresh must not be reported
      // as a failed settlement.
    }
  }

  const selectedTotal = orders
    .filter((o) => selected.includes(o.orderId))
    .reduce((sum, o) => sum + o.outstandingToman, 0);

  return (
    <>
      <PageHeader title="تسویه‌ها" subtitle="ثبت پرداخت به متخصص‌ها و کسب‌وکارها." />

      {error ? <Alert>{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" />
      ) : totals ? (
        <div
          style={{
            display: 'grid',
            gap: 'var(--bc-spacing-card-gap)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            marginBlockEnd: 20,
          }}
        >
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>کارمزد پلتفرم</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>{formatToman(totals.commissionToman)}</p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>سهم فروشندگان</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>{formatToman(totals.receivableToman)}</p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>سفارش‌های پرداخت‌شده</p>
            <p style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>{toPersianDigits(totals.orderCount)}</p>
          </Card>
        </div>
      ) : null}

      <Card>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>یافتن طرف حساب</h2>
        <form onSubmit={lookup} noValidate>
          <Select label="نوع" value={partyType} onChange={(e) => setPartyType(e.target.value as 'professional' | 'business')}>
            <option value="professional">متخصص</option>
            <option value="business">کسب‌وکار</option>
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
      </Card>

      {lookedUp ? (
        <div style={{ marginBlockStart: 20 }}>
          {summary ? (
            <Card>
              <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
                <p style={{ margin: 0 }}>
                  خالص قابل پرداخت: <strong>{formatToman(summary.receivableNetToman)}</strong>
                </p>
                <p style={{ margin: 0 }}>تسویه‌شده تاکنون: {formatToman(summary.settledToman)}</p>
                <p style={{ margin: 0 }}>
                  در انتظار تسویه: <strong>{formatToman(summary.outstandingToman)}</strong>
                </p>
              </div>
            </Card>
          ) : null}

          <div style={{ marginBlockStart: 20 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>سفارش‌های در انتظار تسویه</h2>
            {orders.length === 0 ? (
              <EmptyState message="سفارشی در انتظار تسویه برای این طرف حساب وجود ندارد." />
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8 }}>
                  {orders.map((order) => (
                    <label
                      key={order.orderId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        minHeight: 44,
                        padding: '0 14px',
                        border: `1px solid ${
                          selected.includes(order.orderId) ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'
                        }`,
                        borderRadius: 'var(--bc-radius-row)',
                        cursor: 'pointer',
                        fontSize: 14,
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(order.orderId)}
                          onChange={() =>
                            setSelected((current) =>
                              current.includes(order.orderId)
                                ? current.filter((id) => id !== order.orderId)
                                : [...current, order.orderId],
                            )
                          }
                        />
                        <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                          {order.orderId.slice(0, 8)}
                        </span>
                      </span>
                      <strong>{formatToman(order.outstandingToman)}</strong>
                    </label>
                  ))}
                </div>

                <div style={{ marginBlockStart: 20 }}>
                  <Card>
                    <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>ثبت تسویه</h3>
                    <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 16px' }}>
                      این کار پرداخت را <strong>ثبت</strong> می‌کند؛ انتقال وجه جداگانه و خارج از سامانه انجام
                      می‌شود.
                    </p>
                    <Input label="روش پرداخت" value={method} onChange={(e) => setMethod(e.target.value)} hint="مثلاً: انتقال بانکی" />
                    <Input
                      label="شماره پیگیری"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      hint="شماره پیگیری تراکنش بانکی، برای مطابقت بعدی."
                    />
                    <Textarea label="توضیح" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                    <p style={{ fontSize: 14, marginBlockEnd: 12 }}>
                      مبلغ انتخاب‌شده: <strong>{formatToman(selectedTotal)}</strong> (
                      {toPersianDigits(selected.length)} سفارش)
                    </p>
                    <Button type="button" disabled={selected.length === 0} onClick={() => setPending(true)}>
                      ثبت تسویه
                    </Button>
                  </Card>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending}
        title="ثبت تسویه"
        confirmLabel="ثبت کن"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(false)}
        body={
          <>
            <p style={{ margin: '0 0 8px' }}>
              تسویه {formatToman(selectedTotal)} برای {toPersianDigits(selected.length)} سفارش ثبت می‌شود.
            </p>
            <p style={{ margin: 0 }}>
              دفتر مالی فقط قابل افزودن است؛ این رکورد قابل حذف نیست و برگشت آن نیازمند عملیات جداگانه است.
            </p>
          </>
        }
      />
    </>
  );
}
