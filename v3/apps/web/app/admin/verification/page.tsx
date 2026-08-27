'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { decideVerification, verificationQueue, type VerificationQueueItem } from '@/lib/admin-api';

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
      setError(err instanceof Error ? err.message : 'ثبت تصمیم انجام نشد.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="صف احراز هویت"
        subtitle="درخواست‌های در انتظار بررسی. هر تصمیم با نام شما و دلیل آن ثبت می‌شود و قابل حذف نیست."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {/* An honest statement of a real boundary rather than an empty widget.
          Phase C introduces object storage; V3 has no file-upload capability of
          any kind today, so there are no documents to show and inventing a
          placeholder for them would misrepresent what an operator is deciding
          on. */}
      <Alert tone="success">
        در این نسخه، درخواست‌ها بدون بارگذاری مدرک ارسال می‌شوند. امکان پیوست مدارک در فاز بعدی اضافه خواهد شد.
      </Alert>

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری صف…" />
      ) : loaded && items.length === 0 ? (
        <EmptyState message="درخواست بررسی‌نشده‌ای وجود ندارد." />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
          {items.map((item) => (
            <Card key={item.id}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 'var(--bc-spacing-chip-gap)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{item.displayName}</p>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                    ارسال: {formatZonedDateTime(new Date(item.submittedAt))}
                  </p>
                  <p
                    style={{
                      margin: '4px 0 0',
                      fontSize: 12,
                      color: 'var(--bc-color-ink-faint)',
                    }}
                  >
                    متخصص:{' '}
                    <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'monospace' }}>
                      {item.professionalId.slice(0, 8)}
                    </span>
                  </p>
                  {item.note ? (
                    <p style={{ margin: '8px 0 0', fontSize: 14 }}>«{item.note}»</p>
                  ) : (
                    <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>
                      توضیحی ثبت نشده است.
                    </p>
                  )}
                </div>
                <Badge tone="warning">در انتظار بررسی</Badge>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBlockStart: 16 }}>
                <Button type="button" inline onClick={() => setPending({ item, decision: 'approve' })}>
                  تأیید
                </Button>
                <Button type="button" variant="danger" inline onClick={() => setPending({ item, decision: 'reject' })}>
                  رد
                </Button>
              </div>
            </Card>
          ))}
          {loaded && items.length > 0 ? (
            <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', margin: 0 }}>
              {toPersianDigits(items.length)} درخواست در صف.
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.decision === 'approve' ? 'تأیید احراز هویت' : 'رد درخواست احراز هویت'}
        tone={pending?.decision === 'approve' ? 'primary' : 'danger'}
        confirmLabel={pending?.decision === 'approve' ? 'تأیید نهایی' : 'رد کن'}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setReason('');
        }}
        body={
          <>
            <p style={{ margin: '0 0 12px' }}>
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
                submit is better than a validation error afterwards. */}
            {reason.trim().length > 0 && reason.trim().length < 4 ? (
              <p style={{ fontSize: 12, color: 'var(--bc-color-error)', margin: 0 }}>
                دلیل باید حداقل ۴ نویسه باشد.
              </p>
            ) : null}
          </>
        }
      />
    </>
  );
}
