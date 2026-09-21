'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, DataCell, DataRow, DataTable, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { decideMediaReport, mediaReports, type MediaAbuseReport } from '@/lib/admin-api';
import { mediaReportReasonLabel } from '@/lib/moderation-labels';
import styles from './media.module.css';

/** `DecideAbuseReportDto`: 4–500 characters, on both decisions. */
const MIN_REASON = 4;

/**
 * Whether a moderator can be shown the image a report is about.
 *
 * Always false today, and on purpose: `GET /v1/admin/media/reports` returns a
 * `mediaObjectId` and nothing that locates the picture. A public object's key
 * is `public/<purpose>/<id>` and the report row does not carry the purpose, and
 * in production the public URL belongs to the storage driver, not to this API,
 * so the web app cannot build it either.
 *
 * Upholding a report DELETES the bytes and cannot be undone, so it is not
 * offered on an image nobody can look at. Rejecting is: a wrongful rejection
 * can be corrected, because the image can be reported again. When the API
 * returns a way to show the image (#265), this is the one place that changes —
 * together with the irreversible-deletion confirmation the design asks for.
 */
function canShowImage(_report: MediaAbuseReport): boolean {
  return false;
}

export default function AdminMediaPage() {
  // Content moderation, not platform operation: `bc_moderate_media` is a
  // separate capability from verification so that approving a professional's
  // identity never carries takedown authority with it.
  return (
    <AdminGuard capability="bc_moderate_media">
      <MediaQueue />
    </AdminGuard>
  );
}

/** A refusal in words the moderator can act on. Reload first, report after. */
function refusalMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    // The server's compare-and-swap lost: a colleague decided it first. The
    // media route says exactly that with its own code, so the page may too.
    if (err.code === 'CONFLICT') return 'این گزارش پیش‌تر توسط اپراتور دیگری بررسی شده است. صف تازه شد.';
    if (err.status === 404) return 'این گزارش دیگر در صف نیست. صف تازه شد.';
    return err.message;
  }
  return 'ثبت تصمیم انجام نشد.';
}

function MediaQueue() {
  const { api } = useAuth();
  const [items, setItems] = useState<MediaAbuseReport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const titleId = useId();
  const panelId = useId();
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const queueRef = useRef<HTMLElement | null>(null);
  // After a decision the queue reloads; focus then goes to the row now sitting
  // where the decided one was (`27_ADMIN_MEDIA_MODERATION.md`, accessibility).
  const focusIndexAfterLoad = useRef<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await mediaReports(api);
      setItems(res.data ?? []);
      setTotal(res.meta?.pagination?.total ?? (res.data ?? []).length);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'صف گزارش‌های تصویر بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const index = focusIndexAfterLoad.current;
    if (index === null || loading) return;
    focusIndexAfterLoad.current = null;
    const next = items[Math.min(index, items.length - 1)];
    if (next) rowButton(next.id)?.focus();
    else headingRef.current?.focus();
  }, [items, loading]);

  // Found in the DOM rather than held in a ref map: `Button` does not forward a
  // ref, and the row's own `data-report` already names it.
  const rowButton = (id: string) =>
    queueRef.current?.querySelector<HTMLButtonElement>(`[data-report="${id}"] button`) ?? null;

  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId) panelHeadingRef.current?.focus();
  }, [selectedId]);

  function open(item: MediaAbuseReport) {
    setSelectedId(item.id);
    setReason('');
  }

  function close() {
    const id = selectedId;
    setSelectedId(null);
    setReason('');
    if (id) rowButton(id)?.focus();
  }

  async function decide(decision: 'uphold' | 'reject') {
    if (!selected) return;
    const index = items.findIndex((item) => item.id === selected.id);
    setBusy(true);
    setError(null);
    try {
      await decideMediaReport(api, selected.id, { decision, reason: reason.trim() });
      setSelectedId(null);
      setReason('');
      focusIndexAfterLoad.current = index;
      await load();
    } catch (err) {
      setSelectedId(null);
      setReason('');
      // Reload FIRST, then report: `load` clears the error, so the other way
      // round the refusal vanished the moment it was set.
      const message = refusalMessage(err);
      focusIndexAfterLoad.current = index;
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const reasonLength = reason.trim().length;
  const reasonTooShort = reasonLength < MIN_REASON;
  const imageShown = selected ? canShowImage(selected) : false;

  return (
    <div className={styles.page}>
      <PageHeader
        title="گزارش‌های تصویر"
        subtitle="تصاویر عمومی‌ای که کاربران نامناسب دانسته‌اند. هر تصمیم با نام شما و دلیل آن ثبت می‌شود و قابل حذف نیست."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <div className={`${styles.layout} ${selected ? styles.withPanel : ''}`}>
        <section ref={queueRef} className={styles.queue} aria-labelledby={titleId}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.sectionTitle}>
            صف گزارش‌های باز
          </h2>
          {loading && !loaded ? (
            <LoadingState label="در حال بارگذاری صف…" lines={4} />
          ) : loaded && items.length === 0 ? (
            <EmptyState message="هیچ گزارشِ بازی وجود ندارد." />
          ) : loaded ? (
            <>
              <DataTable head={['کنش', 'تصویر', 'دلیل گزارش', 'یادداشت گزارش‌دهنده', 'تاریخ']} aria-labelledby={titleId}>
                {items.map((item) => {
                  const date = formatZonedDateTime(new Date(item.createdAt));
                  const reasonText = mediaReportReasonLabel(item.reason);
                  return (
                    <DataRow key={item.id} data-report={item.id} data-selected={item.id === selectedId || undefined}>
                      <DataCell label="کنش">
                        <Button
                          type="button"
                          variant="ghost"
                          inline
                          aria-expanded={item.id === selectedId}
                          aria-controls={panelId}
                          aria-label={`بررسی گزارش «${reasonText}» از ${date}`}
                          onClick={() => open(item)}
                        >
                          بررسی
                        </Button>
                      </DataCell>
                      <DataCell label="تصویر">
                        <span className={`${styles.id} ${styles.shortId}`}>{item.mediaObjectId.slice(0, 8)}</span>
                      </DataCell>
                      <DataCell label="دلیل گزارش">
                        <Badge tone="warning">{reasonText}</Badge>
                      </DataCell>
                      <DataCell label="یادداشت گزارش‌دهنده">
                        {item.note ? (
                          <span className={styles.clamp}>{item.note}</span>
                        ) : (
                          <span className={styles.muted}>بدون یادداشت</span>
                        )}
                      </DataCell>
                      <DataCell label="تاریخ">{date}</DataCell>
                    </DataRow>
                  );
                })}
              </DataTable>
              <p className={styles.count}>
                {toPersianDigits(total)} گزارش باز
                {total > items.length ? ` — ${toPersianDigits(items.length)} مورد قدیمی‌تر در این صفحه` : ''}.
              </p>
            </>
          ) : null}
        </section>

        {selected ? (
          <section id={panelId} className={styles.panel} aria-labelledby={`${panelId}-title`} data-panel={selected.id}>
            <div className={styles.panelHead}>
              <h2 id={`${panelId}-title`} ref={panelHeadingRef} tabIndex={-1} className={styles.panelTitle}>
                گزارش {mediaReportReasonLabel(selected.reason)}
              </h2>
              <Button type="button" variant="ghost" inline onClick={close} disabled={busy}>
                بستن
              </Button>
            </div>

            <dl className={styles.meta}>
              <div>
                <dt>دلیل گزارش</dt>
                <dd>{mediaReportReasonLabel(selected.reason)}</dd>
              </div>
              <div>
                <dt>تاریخ گزارش</dt>
                <dd>{formatZonedDateTime(new Date(selected.createdAt))}</dd>
              </div>
              <div>
                <dt>شناسهٔ تصویر</dt>
                <dd>
                  <span className={styles.id}>{selected.mediaObjectId}</span>
                </dd>
              </div>
              <div>
                <dt>یادداشت گزارش‌دهنده</dt>
                <dd>{selected.note ? <span className={styles.note}>{selected.note}</span> : 'بدون یادداشت'}</dd>
              </div>
            </dl>

            {imageShown ? null : (
              <p className={styles.noImage} id={`${panelId}-noimage`} role="note">
                پیش‌نمایش این تصویر هنوز از سرور در دسترس نیست. چون حذف تصویر غیرقابل‌بازگشت است، «تأیید و حذف» تا وقتی
                نتوان خودِ تصویر را دید غیرفعال است. رد گزارش ممکن است؛ اگر تصویر واقعاً نامناسب باشد، می‌توان دوباره
                گزارشش کرد.
              </p>
            )}

            <Textarea
              label="دلیل تصمیم"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              hint="اجباری، حداقل ۴ نویسه. این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
            />
            {reasonLength > 0 && reasonTooShort ? (
              <p className={styles.reasonError}>دلیل باید حداقل ۴ نویسه باشد.</p>
            ) : null}

            <div className={styles.decisions}>
              <Button
                type="button"
                variant="danger"
                inline
                disabled={!imageShown || reasonTooShort || busy}
                aria-describedby={imageShown ? undefined : `${panelId}-noimage`}
                onClick={() => void decide('uphold')}
              >
                تأیید و حذف
              </Button>
              <Button
                type="button"
                variant="ghost"
                inline
                loading={busy}
                disabled={reasonTooShort}
                onClick={() => void decide('reject')}
              >
                رد گزارش
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
