'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { notificationStatus, retryDueNotifications, type NotificationStatus } from '@/lib/admin-api';

const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'درون‌برنامه‌ای',
  sms: 'پیامک',
  email: 'ایمیل',
  push: 'اعلان موبایل',
};

export default function AdminNotificationsPage() {
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
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>کانال‌ها</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {status.channels.map((channel) => (
                <div
                  key={channel.channel}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--bc-spacing-chip-gap)',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {CHANNEL_LABELS[channel.channel] ?? channel.channel}
                  </span>
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
              <p style={{ margin: '16px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                کانال‌های{' '}
                {unverified.map((c) => CHANNEL_LABELS[c.channel] ?? c.channel).join('، ')} در این محیط به سرویس
                واقعی متصل نیستند و پیام‌ها فقط ثبت می‌شوند. اتصال سرویس واقعی خارج از دامنه این نسخه است.
              </p>
            ) : null}
          </Card>

          <div style={{ marginBlockStart: 20 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--bc-spacing-chip-gap)',
                marginBlockEnd: 12,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
                ناموفق نهایی ({toPersianDigits(status.deadLetters.total)})
              </h2>
              <Button type="button" variant="ghost" inline onClick={() => setPending(true)}>
                تلاش مجدد برای موارد سررسیدشده
              </Button>
            </div>

            {status.deadLetters.items.length === 0 ? (
              <EmptyState message="اعلان ناموفقی وجود ندارد." />
            ) : (
              <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
                {status.deadLetters.items.map((item) => (
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
                        <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{item.templateKey}</p>
                        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                          {CHANNEL_LABELS[item.channel] ?? item.channel} — {item.category}
                        </p>
                        {item.deadLetteredAt ? (
                          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                            {formatZonedDateTime(new Date(item.deadLetteredAt))}
                          </p>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
          <p style={{ margin: 0 }}>
            اعلان‌های ناموفقی که زمان تلاش بعدی‌شان فرا رسیده، دوباره ارسال می‌شوند. این عملیات در گزارش عملیات ثبت
            می‌شود.
          </p>
        }
      />
    </>
  );
}
