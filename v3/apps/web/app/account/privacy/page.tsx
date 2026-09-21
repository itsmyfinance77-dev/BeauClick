'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatZonedDateTime, formatZonedFullDate, toPersianDigits } from '@beauclick/persian-utils';
import { ProtectedRoute } from '@/components/protected-route';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, PageHeader } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import {
  ERASURE_CONFIRMATION,
  cancelErasure,
  downloadExport,
  isOpen,
  latestOfKind,
  privacyRequests,
  requestErasure,
  requestExport,
  type ExportDocument,
  type PrivacyRequest,
} from '@/lib/privacy-api';
import { LEGALLY_RETAINED_MODULES, moduleLabel, requestStatusView } from '@/lib/privacy-labels';
import { daysLeftLabel, saveJsonFile } from '@/lib/privacy-time';
import styles from './privacy.module.css';

/**
 * Privacy and my data — `29_PRIVACY_ACCOUNT.md`.
 *
 * Two cards, two decisions, two weights: getting a copy of your data, and
 * asking for your account to be deleted after a seven-day window you can cancel
 * in. There is no user id in any request — the server takes the subject from
 * the session — and no signed download link: the export is fetched with the
 * session and saved from the browser.
 *
 * Two rules from the spec are worth naming here because they are easy to get
 * wrong:
 *
 *  - Nothing on this page says deletion "cannot be undone". It can, until the
 *    exact moment it runs, and the account stays fully usable throughout. The
 *    page shows the date it runs and a cancel button instead.
 *  - The server answers "not found" identically for four different reasons
 *    (someone else's, missing, not ready, expired). The page shows the
 *    server's sentence and never invents a more precise one.
 */
export default function PrivacyPage() {
  return (
    <ProtectedRoute>
      <Privacy />
    </ProtectedRoute>
  );
}

function Privacy() {
  const { api } = useAuth();
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await privacyRequests(api);
      setRequests(res.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست درخواست‌های شما بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.page}>
      <PageHeader title="حریم خصوصی و داده‌های من" subtitle="یک نسخه از داده‌هایتان بگیرید، یا حذف حساب را درخواست کنید." />

      {loading && !loaded ? (
        <LoadingState label="در حال بارگذاری…" lines={5} />
      ) : error && !loaded ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <>
          <ExportCard request={latestOfKind(requests, 'export')} reload={load} />
          <ErasureCard request={latestOfKind(requests, 'erasure')} reload={load} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- export

function ExportCard({ request, reload }: { request: PrivacyRequest | null; reload: () => Promise<void> }) {
  const { api } = useAuth();
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [document_, setDocument] = useState<ExportDocument | null>(null);

  const open = isOpen(request);

  async function ask() {
    setBusy(true);
    setMessage(null);
    setAnnouncement('');
    try {
      await requestExport(api);
      await reload();
    } catch (err) {
      // A 409 is the server's own sentence about the request already open —
      // shown as it is, and the list is re-read so that request is what appears.
      setMessage(err instanceof Error && err.message ? err.message : 'ثبت درخواست انجام نشد. دوباره تلاش کنید.');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!request) return;
    setDownloading(true);
    setMessage(null);
    setAnnouncement('');
    try {
      const res = await downloadExport(api, request.id);
      const doc = res.data?.document ?? null;
      if (!doc) throw new Error('فایل دریافت نشد.');
      saveJsonFile(`beauclick-data-${doc.generatedAt.slice(0, 10)}.json`, doc);
      setDocument(doc);
      setAnnouncement('فایل داده‌های شما ذخیره شد.');
    } catch (err) {
      // The server says one thing for four different reasons; so does the page.
      setMessage(err instanceof Error && err.message ? err.message : 'دریافت فایل انجام نشد.');
    } finally {
      setDownloading(false);
    }
  }

  const status = request ? requestStatusView('export', request.status) : null;

  return (
    <section className={styles.card} aria-labelledby="privacy-export-heading">
      <div className={styles.head}>
        <h2 id="privacy-export-heading" className={styles.title}>
          دریافت خروجی داده‌ها
        </h2>
        {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </div>

      <p className={styles.text}>
        یک فایل کامل از داده‌هایی که بیوکلیک دربارهٔ شما دارد. آماده‌سازی‌اش کمی طول می‌کشد و فایل برای مدت محدودی در دسترس است.
      </p>

      {open ? (
        <p role="status" className={styles.status}>
          درخواست شما در حال آماده‌سازی است.
        </p>
      ) : null}
      {request?.status === 'ready' ? (
        <p role="status" className={`${styles.status} ${styles.statusReady}`}>
          فایل شما آماده است
          {request.expiresAt ? (
            <>
              {' '}
              و تا <span className={styles.strong}>{formatZonedFullDate(new Date(request.expiresAt))}</span> در دسترس است
            </>
          ) : null}
          .
        </p>
      ) : null}
      {request?.status === 'expired' ? (
        // A normal ending, not an error: the file was only ever meant to be there for a while.
        <p role="status" className={styles.status}>
          فایل شما دیگر در دسترس نیست. برای دریافت نسخهٔ تازه، درخواست جدیدی ثبت کنید.
        </p>
      ) : null}
      {request?.status === 'failed' ? (
        <p role="status" className={`${styles.status} ${styles.statusFailed}`}>
          مشکلی پیش آمد و فایل ساخته نشد. دوباره تلاش کنید.
        </p>
      ) : null}

      <div className={styles.actions}>
        {request?.status === 'ready' ? (
          <Button type="button" loading={downloading} onClick={() => void download()}>
            دانلود فایل داده‌ها
          </Button>
        ) : null}
        {open ? (
          <Button type="button" variant="ghost" onClick={() => void reload()}>
            بررسی دوباره
          </Button>
        ) : null}
        <Button
          type="button"
          variant={request?.status === 'ready' ? 'ghost' : 'primary'}
          disabled={open}
          loading={busy}
          onClick={() => void ask()}
        >
          {request?.status === 'failed' ? 'تلاش دوباره' : request ? 'درخواست خروجی تازه' : 'درخواست دریافت داده‌ها'}
        </Button>
      </div>

      {message ? (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      ) : null}
      <p className={styles.announce} role="status" aria-live="polite">
        {announcement}
      </p>

      {document_ ? <WhatTheFileHolds document={document_} /> : null}
    </section>
  );
}

/**
 * What the file just saved contains, and what the platform keeps regardless.
 *
 * The export document carries its own `retained` list, because the subject is
 * entitled to know. It is shown as a list a person can read, not as raw JSON.
 * The reasons are the server's own words (technical, in English) and are shown
 * as such, beside a Persian module name — only for the two modules the spec
 * gives a plain-language sentence for is anything said beyond that.
 */
function WhatTheFileHolds({ document: doc }: { document: ExportDocument }) {
  const descriptions = Array.from(new Set(Object.values(doc.sections).map((s) => s.description)));
  const byModule = new Map<string, ExportDocument['retained']>();
  for (const entry of doc.retained) {
    byModule.set(entry.module, [...(byModule.get(entry.module) ?? []), entry]);
  }

  return (
    <div className={styles.disclosure}>
      {descriptions.length > 0 ? (
        <>
          <h3 className={styles.subtitle}>آنچه در فایل شما هست</h3>
          <ul className={styles.plain}>
            {descriptions.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      ) : null}

      {byModule.size > 0 ? (
        <>
          <h3 className={styles.subtitle}>آنچه نگه داشته می‌شود</h3>
          <ul className={styles.retained}>
            {[...byModule.entries()].map(([moduleKey, entries]) => (
              <li key={moduleKey}>
                <details className={styles.retainedItem}>
                  <summary>
                    {LEGALLY_RETAINED_MODULES.includes(moduleKey) ? (
                      <span>
                        <span className={styles.strong}>{moduleLabel(moduleKey)}:</span> سابقهٔ شما نگه داشته می‌شود چون قانوناً الزامی است.
                      </span>
                    ) : (
                      <span>
                        <span className={styles.strong}>{moduleLabel(moduleKey)}:</span> {toPersianDigits(entries.length)} مورد نگه داشته می‌شود.
                      </span>
                    )}
                  </summary>
                  {entries.map((entry) => (
                    <p key={`${entry.table}`} className={styles.technical}>
                      {entry.table} — {entry.reason}
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ erasure

function ErasureCard({ request, reload }: { request: PrivacyRequest | null; reload: () => Promise<void> }) {
  const { api } = useAuth();
  const [dialog, setDialog] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const open = isOpen(request);
  // The window can be left only while the request is still `pending`; once the
  // sweep has claimed it (`processing`) there is nothing left to cancel.
  const cancellable = request?.status === 'pending' && !!request.executeAfter;
  const status = request ? requestStatusView('erasure', request.status) : null;

  function close() {
    setDialog(false);
    setTyped('');
  }

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      await requestErasure(api);
      close();
      await reload();
    } catch (err) {
      close();
      setMessage(err instanceof Error && err.message ? err.message : 'ثبت درخواست انجام نشد. دوباره تلاش کنید.');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!request) return;
    setCancelling(true);
    setMessage(null);
    try {
      await cancelErasure(api, request.id);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : 'لغو درخواست انجام نشد. دوباره تلاش کنید.');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className={`${styles.card} ${styles.cardDanger}`} aria-labelledby="privacy-erasure-heading">
      <div className={styles.head}>
        <h2 id="privacy-erasure-heading" className={styles.title}>
          حذف حساب
        </h2>
        {status && request?.status !== 'completed' ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      </div>

      {open && request?.executeAfter ? (
        <>
          <p role="status" className={styles.status}>
            حذف حساب شما در <span className={styles.strong}>{formatZonedDateTime(new Date(request.executeAfter))}</span> اجرا می‌شود
            {request.status === 'pending' ? (
              <>
                {' '}
                ({daysLeftLabel(request.executeAfter)})
              </>
            ) : null}
            . تا آن لحظه حساب شما کاملاً قابل‌استفاده است و می‌توانید درخواست را لغو کنید.
          </p>
          {cancellable ? (
            <div className={styles.actions}>
              <Button type="button" variant="ghost" loading={cancelling} onClick={() => void cancel()}>
                لغو درخواست حذف
              </Button>
            </div>
          ) : (
            <p className={styles.text}>درخواست شما هم‌اکنون در حال اجراست و دیگر قابل لغو نیست.</p>
          )}
        </>
      ) : (
        <>
          {request?.status === 'cancelled' ? (
            <p role="status" className={styles.status}>
              درخواست حذف قبلی شما لغو شد و حسابتان بدون تغییر مانده است.
            </p>
          ) : null}
          {request?.status === 'failed' ? (
            <p role="status" className={`${styles.status} ${styles.statusFailed}`}>
              مشکلی پیش آمد و درخواست حذف اجرا نشد. حساب شما بدون تغییر مانده است.
            </p>
          ) : null}
          <p className={styles.text}>
            با درخواست حذف، یک پنجرهٔ هفت‌روزه شروع می‌شود. در این مدت حساب شما کاملاً قابل‌استفاده می‌ماند و در هر لحظه می‌توانید درخواست را
            لغو کنید. پس از پایان پنجره، حساب و داده‌های شخصی شما حذف می‌شود.
          </p>
          <p className={styles.text}>
            سابقهٔ پرداخت شما حذف نمی‌شود و چون قانوناً الزامی است نگه داشته می‌شود.
          </p>
          <div className={styles.actions}>
            <Button type="button" variant="danger" onClick={() => setDialog(true)}>
              شروع حذف حساب
            </Button>
          </div>
        </>
      )}

      {message ? (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      ) : null}

      <ConfirmDialog
        open={dialog}
        title="حذف حساب"
        tone="danger"
        confirmLabel="شروع حذف"
        busy={busy}
        confirmDisabled={typed !== ERASURE_CONFIRMATION}
        onConfirm={() => void start()}
        onCancel={close}
        body={
          <>
            <p className={styles.dialogText}>
              پنجرهٔ هفت‌روزه با تأیید شما شروع می‌شود. تاریخ دقیق اجرا را بلافاصله در همین صفحه می‌بینید و تا آن لحظه می‌توانید لغو کنید.
            </p>
            <div className={styles.confirmField}>
              <label htmlFor="privacy-erasure-confirm" className={styles.confirmLabel}>
                برای تأیید، عبارت <span className={styles.confirmWord}>{ERASURE_CONFIRMATION}</span> را تایپ کنید
              </label>
              <input
                id="privacy-erasure-confirm"
                className={styles.confirmInput}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                dir="ltr"
              />
            </div>
          </>
        }
      />
    </section>
  );
}
