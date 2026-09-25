'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState, Skeleton } from '@/components/ui';
import { Badge, ConfirmDialog, DataCell, DataRow, DataTable, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { decideMediaReport, mediaReportInspection, mediaReports, type MediaAbuseReport } from '@/lib/admin-api';
import { mediaReportReasonLabel } from '@/lib/moderation-labels';
import styles from './media.module.css';

/** `DecideAbuseReportDto`: 4–500 characters, on both decisions. */
const MIN_REASON = 4;

/**
 * The inspection of one report's image (#265, `52_MODERATOR_LANDING.md` §5).
 *
 * The URL comes from `GET /v1/admin/media/reports/:id/inspection`: minted for
 * this moderator, short-lived, re-authorized by the API on every request. It
 * is only ever an `<img>` source -- never shown, copied, logged, put in an
 * error, opened or downloaded.
 *
 *   loading       the URL is being minted, or re-minted after the image failed
 *   ready         an image can be rendered from `url` until `expiresAt`
 *   unavailable   the shared refusal: the object is gone, private, foreign or
 *                 the report is no longer open -- never which
 *   failed        the URL could not be fetched, or the image failed again after
 *                 its one silent re-request: the moderator may ask again
 */
type Inspection =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; expiresAt: number }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/** The image's text alternative, always: never anything the uploader wrote. */
const IMAGE_ALT = 'تصویرِ گزارش‌شده';
const UNAVAILABLE = 'تصویر در دسترس نیست';
const UPHOLD_BLOCKED = 'تا نمایش تصویر، حذف ممکن نیست.';
const CONSEQUENCE = 'حذف تصویر برگشت‌پذیر نیست.';

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
  const [confirming, setConfirming] = useState(false);

  // One inspection per report, shared by its queue row and its panel, kept
  // across queue reloads so a decision does not re-mint every other row.
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  // The URL whose image has actually rendered IN THE PANEL, per report. Uphold
  // needs this to equal the current URL: a thumbnail is not an inspection.
  const [shownUrl, setShownUrl] = useState<Record<string, string>>({});
  // Whether the one silent re-request after an image error has been spent. A
  // successful render gives it back, so a later expiry is also silent once.
  const silentRetryUsed = useRef<Record<string, boolean>>({});
  // Only the latest request for a report may land.
  const requestSeq = useRef<Record<string, number>>({});
  const inspectionsRef = useRef(inspections);
  inspectionsRef.current = inspections;

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

  const inspect = useCallback(
    async (reportId: string) => {
      const seq = (requestSeq.current[reportId] ?? 0) + 1;
      requestSeq.current[reportId] = seq;
      setInspections((prev) => ({ ...prev, [reportId]: { kind: 'loading' } }));
      let next: Inspection;
      try {
        const res = await mediaReportInspection(api, reportId);
        const expiresAt = Date.parse(res.data?.expiresAt ?? '');
        next =
          res.data?.inspectionUrl && Number.isFinite(expiresAt)
            ? { kind: 'ready', url: res.data.inspectionUrl, expiresAt }
            : { kind: 'failed' };
      } catch (err) {
        // A 403 has already asked `/v1/me` again (the client's admin hook); if
        // the capability is gone, the guard clears this whole page.
        next = err instanceof ApiRequestError && err.status === 404 ? { kind: 'unavailable' } : { kind: 'failed' };
      }
      if (requestSeq.current[reportId] !== seq) return;
      setInspections((prev) => ({ ...prev, [reportId]: next }));
    },
    [api],
  );

  // Every report on the page gets its inspection once; a reload keeps the
  // ones still in the queue and forgets the rest.
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(items.map((item) => item.id));
    setInspections((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
    for (const item of items) {
      if (!(item.id in inspectionsRef.current)) void inspect(item.id);
    }
  }, [items, loaded, inspect]);

  function imageShown(reportId: string, url: string) {
    silentRetryUsed.current[reportId] = false;
    setShownUrl((prev) => ({ ...prev, [reportId]: url }));
  }

  /** A panel that opens again must render the image again before uphold returns. */
  function forgetShown(reportId: string) {
    setShownUrl((prev) => {
      if (!(reportId in prev)) return prev;
      const rest = { ...prev };
      delete rest[reportId];
      return rest;
    });
  }

  /** The image errored, or its URL lapsed: uphold goes away until a fresh one renders. */
  function imageFailed(reportId: string) {
    forgetShown(reportId);
    if (!silentRetryUsed.current[reportId]) {
      silentRetryUsed.current[reportId] = true;
      void inspect(reportId);
    } else {
      setInspections((prev) => ({ ...prev, [reportId]: { kind: 'failed' } }));
    }
  }

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
    forgetShown(item.id);
    setSelectedId(item.id);
    setReason('');
    setConfirming(false);
  }

  function close() {
    const id = selectedId;
    if (id) forgetShown(id);
    setSelectedId(null);
    setReason('');
    setConfirming(false);
    if (id) rowButton(id)?.focus();
  }

  async function decide(decision: 'uphold' | 'reject') {
    if (!selected) return;
    // The irreversible decision is re-checked here, not only on the button:
    // a stale click must not send an uphold for an image no longer shown.
    if (decision === 'uphold' && !upholdAllowed) return;
    const index = items.findIndex((item) => item.id === selected.id);
    setBusy(true);
    setError(null);
    try {
      await decideMediaReport(api, selected.id, { decision, reason: reason.trim() });
      setConfirming(false);
      setSelectedId(null);
      setReason('');
      focusIndexAfterLoad.current = index;
      await load();
    } catch (err) {
      setConfirming(false);
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
  const selectedInspection: Inspection = (selected && inspections[selected.id]) || { kind: 'loading' };
  const imageOnScreen =
    selected !== null && selectedInspection.kind === 'ready' && shownUrl[selected.id] === selectedInspection.url;
  const upholdAllowed = imageOnScreen && !reasonTooShort && !busy;

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
                        <RowThumbnail inspection={inspections[item.id] ?? { kind: 'loading' }} />
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

            <PanelImage
              key={selected.id}
              inspection={selectedInspection}
              onShown={(url) => imageShown(selected.id, url)}
              onFailed={() => imageFailed(selected.id)}
              onRetry={() => {
                // An explicit request: the silent one stays spent until an image renders.
                silentRetryUsed.current[selected.id] = true;
                void inspect(selected.id);
              }}
            />

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
                disabled={!upholdAllowed}
                aria-describedby={imageOnScreen ? undefined : `${panelId}-blocked`}
                onClick={() => setConfirming(true)}
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
            {imageOnScreen ? null : (
              <p className={styles.blocked} id={`${panelId}-blocked`}>
                {UPHOLD_BLOCKED}
              </p>
            )}

            <ConfirmDialog
              open={confirming}
              title="حذف تصویر"
              tone="danger"
              confirmLabel="تأیید و حذف"
              busy={busy}
              // Re-evaluated while open: an image that expires or errors under
              // the dialog takes the confirmation away with it.
              confirmDisabled={!upholdAllowed}
              describedById={`${panelId}-consequence`}
              onConfirm={() => void decide('uphold')}
              onCancel={() => setConfirming(false)}
              body={
                <>
                  <p id={`${panelId}-consequence`} className={styles.consequence}>
                    {CONSEQUENCE}
                  </p>
                  <p className={styles.dialogReason}>
                    دلیل ثبت‌شده: <span className={styles.note}>{reason.trim()}</span>
                  </p>
                  {imageOnScreen ? null : <p className={styles.blocked}>{UPHOLD_BLOCKED}</p>}
                </>
              }
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The queue row's thumbnail: the same protected URL as the panel, drawn small.
 * It is not an inspection -- only the panel's own render enables uphold -- so
 * a thumbnail that fails simply stops drawing; the panel owns the retries.
 */
function RowThumbnail({ inspection }: { inspection: Inspection }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (inspection.kind === 'loading') {
    return (
      <span className={styles.thumb} aria-hidden="true">
        <Skeleton width={48} height={48} />
      </span>
    );
  }
  if (inspection.kind === 'ready' && failedUrl !== inspection.url) {
    return (
      <img
        className={styles.thumb}
        src={inspection.url}
        alt={IMAGE_ALT}
        width={48}
        height={48}
        crossOrigin="anonymous"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setFailedUrl(inspection.url)}
      />
    );
  }
  if (inspection.kind === 'unavailable') return <span className={styles.unavailable}>{UNAVAILABLE}</span>;
  return <span className={styles.thumbEmpty} aria-hidden="true" />;
}

/**
 * The decision panel's image, in the four states of screen 52 §5.
 *
 * `crossOrigin="anonymous"` makes the browser fetch it in CORS mode, so the
 * API's origin allow-list -- not a relaxed resource policy -- decides which
 * site may render it. It is never a link, never a download, never text.
 */
function PanelImage({
  inspection,
  onShown,
  onFailed,
  onRetry,
}: {
  inspection: Inspection;
  onShown: (url: string) => void;
  onFailed: () => void;
  onRetry: () => void;
}) {
  const [renderedUrl, setRenderedUrl] = useState<string | null>(null);
  const loading = inspection.kind === 'loading' || (inspection.kind === 'ready' && renderedUrl !== inspection.url);

  // A rendered image outlives its authorization on screen. When the URL
  // lapses, treat it as an image error: uphold is taken away, and the one
  // silent re-request fetches a fresh URL.
  const expiresAt = inspection.kind === 'ready' ? inspection.expiresAt : null;
  const shown = inspection.kind === 'ready' && renderedUrl === inspection.url;
  // The latest callback, read when the timer fires; the timer belongs to the URL.
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  useEffect(() => {
    if (!shown || expiresAt === null) return;
    const timer = setTimeout(
      () => {
        setRenderedUrl(null);
        onFailedRef.current();
      },
      Math.min(Math.max(expiresAt - Date.now(), 0), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [shown, expiresAt]);

  if (inspection.kind === 'unavailable') {
    return (
      <div className={styles.imageFrame} data-image-state="unavailable">
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
      </div>
    );
  }
  if (inspection.kind === 'failed') {
    return (
      <div className={styles.imageFrame} data-image-state="failed">
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
        <Button type="button" variant="ghost" inline onClick={onRetry}>
          دریافت دوباره
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.imageFrame} data-image-state={loading ? 'loading' : 'shown'} aria-busy={loading || undefined}>
      {loading ? <Skeleton height={240} /> : null}
      {inspection.kind === 'ready' ? (
        <img
          key={inspection.url}
          className={loading ? styles.imageLoading : styles.image}
          src={inspection.url}
          alt={IMAGE_ALT}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => {
            setRenderedUrl(inspection.url);
            onShown(inspection.url);
          }}
          onError={() => {
            setRenderedUrl(null);
            onFailed();
          }}
        />
      ) : null}
    </div>
  );
}
