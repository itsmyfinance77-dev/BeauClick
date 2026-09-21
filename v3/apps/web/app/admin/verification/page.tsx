'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import {
  decideVerification,
  verificationEvidence,
  verificationQueue,
  type VerificationEvidence,
  type VerificationQueueItem,
} from '@/lib/admin-api';
import styles from './verification.module.css';

/** The server requires 4–500 characters of reason (`DecideVerificationDto`). */
const MIN_REASON = 4;

export default function AdminVerificationPage() {
  // Gated on the MODERATION capability, not on `bc_manage_platform`. The two
  // are different authorities: the migration's own seed comment explains why
  // `platform_operator` holds this one and why review moderation is separate.
  return (
    <AdminGuard capability="bc_moderate_verification">
      <VerificationQueue />
    </AdminGuard>
  );
}

type EvidenceState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; documents: VerificationEvidence[] };

/**
 * The documents a professional attached to one request.
 *
 * Opened on demand: the queue is one request, and each request's documents are
 * a second only when an operator asks for them. The link is the server's
 * short-lived, per-operator URL — it is opened, never printed, and never
 * stored: it stops working after about five minutes and is re-authorised
 * against the operator's live capability each time.
 *
 * Until this existed the page told the operator "requests are submitted without
 * documents", which had been untrue since the evidence endpoint shipped — a
 * moderator deciding on someone's identity was told there was nothing to look
 * at.
 */
function EvidenceBlock({ requestId }: { requestId: string }) {
  const { api } = useAuth();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EvidenceState | null>(null);
  const panelId = `verification-evidence-${requestId}`;

  const fetchDocuments = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await verificationEvidence(api, requestId);
      setState({ status: 'ready', documents: res.data ?? [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'مدارک بارگذاری نشد.' });
    }
  }, [api, requestId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && state === null) void fetchDocuments();
  }

  return (
    <div className={styles.evidence}>
      <Button type="button" variant="ghost" inline aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {open ? 'پنهان کردن مدارک' : 'مشاهدهٔ مدارک'}
      </Button>
      <div id={panelId} hidden={!open} className={styles.evidenceBody}>
        {state?.status === 'loading' ? <p className={styles.hint}>در حال بارگذاری مدارک…</p> : null}
        {state?.status === 'error' ? (
          <>
            <Alert>{state.message}</Alert>
            <Button type="button" variant="ghost" inline onClick={() => void fetchDocuments()}>
              تلاش دوباره
            </Button>
          </>
        ) : null}
        {state?.status === 'ready' ? (
          state.documents.length === 0 ? (
            <p className={styles.hint}>برای این درخواست مدرکی بارگذاری نشده است.</p>
          ) : (
            <ul className={styles.documents}>
              {state.documents.map((doc, index) => (
                <li key={doc.id} className={styles.document}>
                  <span>
                    مدرک {toPersianDigits(index + 1)}
                    <span className={styles.documentDate}> · {formatZonedDateTime(new Date(doc.createdAt))}</span>
                  </span>
                  <a
                    className={styles.documentLink}
                    href={doc.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`مشاهدهٔ مدرک ${toPersianDigits(index + 1)} (در برگهٔ تازه)`}
                  >
                    مشاهده
                  </a>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}

function VerificationQueue() {
  const { api } = useAuth();
  const [items, setItems] = useState<VerificationQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinguishes "the server says the queue is empty" from "the request
  // failed". Only the first justifies telling an operator there is no work.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<{ item: VerificationQueueItem; decision: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await verificationQueue(api);
      setItems(res.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'صف احراز هویت بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await decideVerification(api, pending.item.id, { decision: pending.decision, reason: reason.trim() });
      setPending(null);
      setReason('');
      // Reload rather than splice: a decision changes what is IN the queue, and
      // a second operator may have decided something else in the meantime. The
      // server's list is the truth.
      await load();
    } catch (err) {
      setPending(null);
      // Reload FIRST, then report: `load` clears the error, so the other way
      // round the server's reason ("already decided") vanished the moment it
      // was set and the operator saw the request simply disappear.
      const message = err instanceof Error ? err.message : 'ثبت تصمیم انجام نشد.';
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const reasonLength = reason.trim().length;

  return (
    <div className={styles.page}>
      <PageHeader
        title="صف احراز هویت"
        subtitle="درخواست‌های در انتظار بررسی. هر تصمیم با نام شما و دلیل آن ثبت می‌شود و قابل حذف نیست."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری صف…" lines={4} />
      ) : loaded && items.length === 0 ? (
        <EmptyState message="درخواست بررسی‌نشده‌ای وجود ندارد." />
      ) : (
        <ul className={styles.queue}>
          {items.map((item) => (
            <li key={item.id} className={styles.panel} data-request={item.id}>
              <div className={styles.head}>
                <div className={styles.who}>
                  <p className={styles.name}>{item.displayName}</p>
                  <p className={styles.submitted}>ارسال: {formatZonedDateTime(new Date(item.submittedAt))}</p>
                  <p className={styles.professional}>
                    متخصص: <span className={styles.id}>{item.professionalId.slice(0, 8)}</span>
                  </p>
                  {item.note ? (
                    <p className={styles.note}>«{item.note}»</p>
                  ) : (
                    <p className={styles.noNote}>توضیحی ثبت نشده است.</p>
                  )}
                </div>
                <Badge tone="warning">در انتظار بررسی</Badge>
              </div>

              <EvidenceBlock requestId={item.id} />

              <div className={styles.decisions}>
                <Button type="button" inline onClick={() => setPending({ item, decision: 'approve' })}>
                  تأیید
                </Button>
                <Button type="button" variant="danger" inline onClick={() => setPending({ item, decision: 'reject' })}>
                  رد
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {loaded && items.length > 0 ? <p className={styles.count}>{toPersianDigits(items.length)} درخواست در صف.</p> : null}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.decision === 'approve' ? 'تأیید احراز هویت' : 'رد درخواست احراز هویت'}
        tone={pending?.decision === 'approve' ? 'primary' : 'danger'}
        confirmLabel={pending?.decision === 'approve' ? 'تأیید نهایی' : 'رد کن'}
        busy={busy}
        confirmDisabled={reasonLength < MIN_REASON}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setReason('');
        }}
        body={
          <>
            <p className={styles.dialogText}>
              {pending?.decision === 'approve'
                ? `پروفایل «${pending?.item.displayName}» تأیید می‌شود و نشان «تأیید شده» در نتایج جست‌وجو نمایش داده خواهد شد.`
                : `درخواست «${pending?.item.displayName}» رد می‌شود. متخصص می‌تواند دوباره درخواست دهد.`}
            </p>
            <Textarea
              label="دلیل تصمیم"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              hint="این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
            />
            {/* The server requires 4-500 characters. Saying so before the
                submit is better than a validation error afterwards — and the
                confirm button waits for it. */}
            {reasonLength > 0 && reasonLength < MIN_REASON ? (
              <p className={styles.reasonError}>دلیل باید حداقل ۴ نویسه باشد.</p>
            ) : null}
          </>
        }
      />
    </div>
  );
}
