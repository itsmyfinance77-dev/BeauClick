'use client';

/**
 * DEMO BRANCH ONLY — F-10 (demo/F10-DESIGN.md): controlled manual-refund
 * execution for the administrator.
 *
 * The order of operations IS the safety property: the claim («شروع اجرای دستی»)
 * must be recorded BEFORE any money is transferred; from that moment the
 * customer can no longer swap the refund for a free reschedule. The outcome is
 * then recorded: executed (with the transfer's reference), uncertain (keeps
 * blocking), or released (a statement that NO transfer was made). Nothing here
 * moves money — the demo's execution is synthetic.
 */
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, formatToman } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Select, type BadgeTone } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { manualRefundApi, type ManualRefundRow } from '@/lib/manual-refund-api';
import styles from './refunds.module.css';

const STATUS: Record<ManualRefundRow['status'], { label: string; tone: BadgeTone }> = {
  manual_required: { label: 'نیازمند اجرای دستی', tone: 'warning' },
  superseded: { label: 'جایگزین‌شده با نوبت تازه', tone: 'neutral' },
  succeeded: { label: 'اجرا شد', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'error' },
  pending: { label: 'در جریان', tone: 'neutral' },
};
const EXEC: Record<string, string> = {
  claimed: 'اجرا شروع شده (ادعا ثبت شد)',
  uncertain: 'نتیجهٔ اجرا نامعلوم',
  executed: 'اجرا شد',
  released: 'بدون انتقال آزاد شد',
};

export default function AdminManualRefundsPage() {
  return (
    <AdminGuard capability="bc_execute_manual_refunds">
      <ManualRefunds />
    </AdminGuard>
  );
}

function ManualRefunds() {
  const { api } = useAuth();
  const [rows, setRows] = useState<ManualRefundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<ManualRefundRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [reference, setReference] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await manualRefundApi.list(api);
      setRows(res.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست بازپرداخت‌ها بارگذاری نشد.');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function claim(row: ManualRefundRow) {
    setBusy(true);
    setActionError(null);
    try {
      await manualRefundApi.claim(api, row.refundId);
      setClaiming(null);
      await load();
    } catch (err) {
      setClaiming(null);
      setActionError(err instanceof Error ? err.message : 'ثبت شروع اجرا ممکن نشد.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function resolve(executionId: string) {
    const o = outcome[executionId] as 'executed' | 'uncertain' | 'released' | undefined;
    if (!o) return;
    setBusy(true);
    setActionError(null);
    try {
      await manualRefundApi.resolve(api, executionId, { outcome: o, ...(o === 'executed' ? { externalReference: reference[executionId]?.trim() } : {}) });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ثبت نتیجه ممکن نشد.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && rows === null) return <ErrorState message={error} onRetry={() => void load()} />;
  if (rows === null) return <LoadingState label="در حال بارگذاری بازپرداخت‌های دستی…" lines={4} />;

  return (
    <section>
      <PageHeader title="بازپرداخت دستی" />
      <Alert tone="warning">
        شبیه‌سازی دمو: هیچ انتقال وجه واقعی انجام نمی‌شود. پیش از هر انتقال، «شروع اجرای دستی» را ثبت کنید؛ سامانه انتقالی را که بدون
        این ثبت و بیرون از آن انجام شود نمی‌تواند تشخیص دهد یا متوقف کند.
      </Alert>
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}
      {rows.length === 0 ? (
        <EmptyState message="بازپرداختی که اجرای دستی لازم داشته باشد وجود ندارد." />
      ) : (
        <ul className={styles.list} data-testid="manual-refunds">
          {rows.map((row) => {
            const active = row.executions.find((e) => e.state === 'claimed' || e.state === 'uncertain');
            const executed = row.executions.find((e) => e.state === 'executed');
            return (
              <li key={row.refundId} className={styles.card} data-refund={row.refundId}>
                <div className={styles.head}>
                  <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                  <strong>{formatToman(row.amountToman)} تومان</strong>
                </div>
                <p className={styles.meta}>
                  {formatFullJalaliDate(new Date(row.requestedAt))} — {row.reason}
                </p>
                {!row.manualTracked && row.status === 'manual_required' ? (
                  <p className={styles.meta}>سابقهٔ اجرای این بازپرداخت پیش از ثبت اجرا بوده و نامعلوم است؛ هرگز با نوبت تازه جایگزین نمی‌شود.</p>
                ) : null}
                {row.executions.map((e) => (
                  <p key={e.executionId} className={styles.meta} data-execution={e.executionId}>
                    {EXEC[e.state]}
                    {e.externalReference ? ` — شناسهٔ پیگیری: ${e.externalReference}` : ''}
                  </p>
                ))}
                {row.status === 'manual_required' && !active && !executed ? (
                  <Button inline disabled={busy} onClick={() => setClaiming(row)} data-testid="manual-claim">
                    شروع اجرای دستی
                  </Button>
                ) : null}
                {active ? (
                  <div className={styles.form}>
                    <Select
                      label="نتیجهٔ اجرا"
                      value={outcome[active.executionId] ?? ''}
                      onChange={(ev) => setOutcome((c) => ({ ...c, [active.executionId]: ev.target.value }))}
                    >
                      <option value="">انتخاب کنید</option>
                      <option value="executed">انتقال انجام شد</option>
                      {active.state === 'claimed' ? <option value="uncertain">نتیجه نامعلوم است</option> : null}
                      <option value="released">هیچ انتقالی انجام نشد (آزاد کردن)</option>
                    </Select>
                    {outcome[active.executionId] === 'executed' ? (
                      <Input
                        label="شناسهٔ پیگیری انتقال"
                        value={reference[active.executionId] ?? ''}
                        maxLength={100}
                        onChange={(ev) => setReference((c) => ({ ...c, [active.executionId]: ev.target.value }))}
                      />
                    ) : null}
                    <Button
                      inline
                      disabled={
                        busy ||
                        !outcome[active.executionId] ||
                        (outcome[active.executionId] === 'executed' && !reference[active.executionId]?.trim())
                      }
                      onClick={() => void resolve(active.executionId)}
                      data-testid="manual-resolve"
                    >
                      ثبت نتیجه
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={claiming !== null}
        title="شروع اجرای دستی بازپرداخت"
        confirmLabel="ثبت شروع اجرا"
        busy={busy}
        onConfirm={() => claiming && void claim(claiming)}
        onCancel={() => setClaiming(null)}
        body={
          <p>
            این ثبت باید پیش از هر انتقال وجه انجام شود. از این لحظه مشتری نمی‌تواند این بازپرداخت را با نوبت تازه جایگزین کند، تا زمانی
            که نتیجه («انجام شد» یا «هیچ انتقالی انجام نشد») ثبت شود. زمان‌بندی خودکاری این ثبت را آزاد نمی‌کند.
          </p>
        }
      />
    </section>
  );
}
