'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { AdminGuard } from '@/components/admin-guard';
import { notificationStatus, retryDueNotifications, type NotificationStatus } from '@/lib/admin-api';
import styles from './notifications.module.css';

const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'درون‌برنامه‌ای',
  sms: 'پیامک',
  email: 'ایمیل',
  push: 'اعلان موبایل',
};

function AdminNotificationsContent() {
  const { api } = useAuth();

  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await notificationStatus(api);
      setStatus(res.data ?? null);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'وضعیت اعلان‌ها بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await retryDueNotifications(api);
      const data = res.data;
      setResult(
        `${toPersianDigits(data?.attempted ?? 0)} مورد تلاش شد؛ ${toPersianDigits(
          data?.sent ?? 0,
        )} ارسال و ${toPersianDigits(data?.deadLettered ?? 0)} به‌طور نهایی ناموفق شد.`,
      );
      setPending(false);
      await load();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'اجرای تلاش مجدد انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  const unverified = status?.channels.filter((c) => !c.providerVerified) ?? [];

  return (
    <>
      <PageHeader title="اعلان‌ها" subtitle="وضعیت کانال‌ها و اعلان‌هایی که پس از چند تلاش ارسال نشدند." />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {result ? <Alert tone="success">{result}</Alert> : null}

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" />
      ) : status ? (
        <>
          <Card>
            <h2 className={styles.channelsTitle}>کانال‌ها</h2>
            <div className={styles.channelsList}>
              {status.channels.map((channel) => (
                <div key={channel.channel} className={styles.channelRow}>
                  <span className={styles.channelName}>{CHANNEL_LABELS[channel.channel] ?? channel.channel}</span>
                  {channel.providerVerified ? (
                    <Badge tone="success">ارسال واقعی</Badge>
                  ) : (
                    <Badge tone="warning">فقط ثبت در گزارش — ارسال واقعی انجام نمی‌شود</Badge>
                  )}
                </div>
              ))}
            </div>

            {/* GAP-11, stated plainly on the screen rather than left in a
                document. An operator seeing "sent" counts must know that some
                channels do not actually deliver anywhere. */}
            {unverified.length > 0 ? (
              <p className={styles.unverifiedNote}>
                کانال‌های{' '}
                {unverified.map((c) => CHANNEL_LABELS[c.channel] ?? c.channel).join('، ')} در این محیط به سرویس
                واقعی متصل نیستند و پیام‌ها فقط ثبت می‌شوند. اتصال سرویس واقعی خارج از دامنه این نسخه است.
              </p>
            ) : null}
          </Card>

          <div className={styles.deadLettersSection}>
            <div className={styles.deadLettersHeader}>
              <h2 className={styles.deadLettersTitle}>ناموفق نهایی ({toPersianDigits(status.deadLetters.total)})</h2>
              <Button type="button" variant="ghost" inline onClick={() => setPending(true)}>
                تلاش مجدد برای موارد سررسیدشده
              </Button>
            </div>

            {status.deadLetters.items.length === 0 ? (
              <EmptyState message="اعلان ناموفقی وجود ندارد." />
            ) : (
              <div className={styles.deadLettersList}>
                {status.deadLetters.items.map((item) => (
                  <Card key={item.id}>
                    <div className={styles.deadLetterHeader}>
                      <div className={styles.deadLetterMain}>
                        <p className={styles.deadLetterTemplate}>{item.templateKey}</p>
                        <p className={styles.deadLetterMeta}>
                          {CHANNEL_LABELS[item.channel] ?? item.channel} — {item.category}
                        </p>
                        {item.deadLetteredAt ? (
                          <p className={styles.deadLetterTime}>{formatZonedDateTime(new Date(item.deadLetteredAt))}</p>
                        ) : null}
                      </div>
                      <div className={styles.deadLetterBadges}>
                        <Badge tone="error">{item.errorCode ?? 'خطای نامشخص'}</Badge>
                        <Badge tone="neutral">{toPersianDigits(item.attempts)} تلاش</Badge>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={pending}
        title="تلاش مجدد برای ارسال"
        confirmLabel="اجرا کن"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(false)}
        body={
          <p className={styles.dialogBody}>
            اعلان‌های ناموفقی که زمان تلاش بعدی‌شان فرا رسیده، دوباره ارسال می‌شوند. این عملیات در گزارش عملیات ثبت
            می‌شود.
          </p>
        }
      />
    </>
  );
}

/**
 * #264: this page's OWN guard. Before #264 the `/admin` layout gated every
 * page on `bc_manage_platform`, and this page relied on that alone. The shell
 * now also admits moderators, so the page states its authority itself — the
 * same capability that gated it before, so nothing changes for an operator or
 * administrator — and a moderator's typed URL is refused here as well as by
 * `AdminRouteGate`. The API's `CapabilityGuard` remains the control.
 */
export default function AdminNotificationsPage() {
  return (
    <AdminGuard capability="bc_manage_platform">
      <AdminNotificationsContent />
    </AdminGuard>
  );
}
