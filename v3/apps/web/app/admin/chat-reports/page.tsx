'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import {
  Badge,
  ConfirmDialog,
  DataCell,
  DataRow,
  DataTable,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Select,
  Textarea,
} from '@/components/kit';
import { AdminGuard } from '@/components/admin-guard';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import {
  chatReport,
  chatReports,
  decideChatReport,
  type ChatModerationAction,
  type ChatReportSummary,
  type ChatReportWindow,
} from '@/lib/admin-api';
import {
  CHAT_ACTION_LABEL,
  CHAT_REPORT_UNAVAILABLE,
  CHAT_REPORT_UNREADABLE,
  chatActionLabel,
  chatReportReasonLabel,
  chatReportStatusView,
} from '@/lib/moderation-labels';
import styles from './chat-reports.module.css';

/** `DecideReportDto`: `@MinLength(3)`, `@MaxLength(500)`. */
const MIN_REASON = 3;

/** `CHAT_MODERATOR_WINDOW_MESSAGES`. The server bounds the window; the page never shows more even if it did not. */
const WINDOW_MAX = 50;

/** The server lists at most this many, oldest first, with no pagination (`ListReportsDto`). */
const LIST_LIMIT = 50;

/**
 * `/admin/chat-reports` — `37_ADMIN_CHAT_MODERATION.md`.
 *
 * ## The absence is the control
 *
 * The only way into a conversation is a REPORT from this queue. There is no
 * conversation browser, no search, no field that takes a conversation, user
 * or report id, and no link out of a message — the API has no such route, and
 * the page mirrors that rather than disabling controls that would suggest one.
 *
 * The queue is metadata only: reason, status, dates, decision. The reporter's
 * note and every message body appear only after a moderator opens one report,
 * and that opening is itself recorded (`chat.report.read`).
 *
 * In the window, a sender is a short fragment of a raw id — never a name,
 * avatar or profile — because those fields do not exist on this read. And the
 * moderator can read and decide, nothing else: no send, edit or delete.
 *
 * ## One refusal
 *
 * A missing report, a foreign one, one whose 30-day post-decision access has
 * lapsed, and one a colleague decided a moment earlier all produce the same
 * 404. The copy says only what that proves — the report is no longer
 * available — and never claims a colleague decided it.
 */
export default function AdminChatReportsPage() {
  // Not `platform_operator`: reading a private conversation and operating the
  // platform are different privileges.
  return (
    <AdminGuard capability="bc_moderate_chat">
      <ChatReportQueue />
    </AdminGuard>
  );
}

type Filter = 'open' | 'upheld' | 'rejected';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'باز' },
  { value: 'upheld', label: 'تأییدشده' },
  { value: 'rejected', label: 'ردشده' },
];

type WindowState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; window: ChatReportWindow };

/** «کاربر …» and eight characters of the raw id: who said what, and nothing about who they are. */
function senderLabel(userId: string): string {
  return `کاربر ${userId.slice(0, 8)}`;
}

const isUnavailable = (err: unknown) => err instanceof ApiRequestError && err.status === 404;

const ACTION_CONSEQUENCE: Record<string, string> = {
  warn_sender: 'یک اخطار برای فرستندهٔ پیام گزارش‌شده ثبت می‌شود. ارسال پیام او محدود نمی‌شود.',
  close_conversation: 'این گفتگو برای همیشه برای ارسال پیام بسته می‌شود. خواندن آن تغییری نمی‌کند.',
  restrict_sender: 'ارسال پیام برای فرستندهٔ پیام گزارش‌شده در همهٔ گفتگوهای پلتفرم محدود می‌شود.',
};

function ChatReportQueue() {
  const { api } = useAuth();
  const [filter, setFilter] = useState<Filter>('open');
  const [items, setItems] = useState<ChatReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WindowState | null>(null);

  const [outcome, setOutcome] = useState<'upheld' | 'rejected' | null>(null);
  const [action, setAction] = useState<ChatModerationAction>('warn_sender');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const titleId = useId();
  const panelId = useId();
  const queueRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const reportedRef = useRef<HTMLLIElement | null>(null);
  const messagesRef = useRef<HTMLOListElement | null>(null);
  const focusIndexAfterLoad = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await chatReports(api, { status: filter, limit: LIST_LIMIT });
      setItems(res.data?.items ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'صف گزارش‌های گفتگو بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // `Button` does not forward a ref; the row's `data-report` names its button.
  const rowButton = (id: string) =>
    queueRef.current?.querySelector<HTMLButtonElement>(`[data-report="${id}"] button`) ?? null;

  useEffect(() => {
    const index = focusIndexAfterLoad.current;
    if (index === null || loading) return;
    focusIndexAfterLoad.current = null;
    const next = items[Math.min(index, items.length - 1)];
    if (next) rowButton(next.id)?.focus();
    else headingRef.current?.focus();
  }, [items, loading]);

  const fetchWindow = useCallback(
    async (id: string) => {
      setDetail({ status: 'loading' });
      try {
        const res = await chatReport(api, id);
        if (!res.data) throw new Error('empty');
        setDetail({ status: 'ready', window: res.data });
      } catch (err) {
        if (isUnavailable(err)) setDetail({ status: 'unavailable' });
        else setDetail({ status: 'error', message: err instanceof Error ? err.message : 'گزارش بارگذاری نشد.' });
      }
    },
    [api],
  );

  function resetDecision() {
    setOutcome(null);
    setAction('warn_sender');
    setReason('');
    setConfirming(false);
  }

  function open(item: ChatReportSummary) {
    setSelectedId(item.id);
    resetDecision();
    void fetchWindow(item.id);
  }

  function close() {
    const id = selectedId;
    setSelectedId(null);
    setDetail(null);
    resetDecision();
    if (id) rowButton(id)?.focus();
  }

  useEffect(() => {
    if (selectedId) panelHeadingRef.current?.focus();
  }, [selectedId]);

  // Centre the reported message inside the window's own scroll box — never
  // scrolling the page, and never moving focus.
  useEffect(() => {
    const list = messagesRef.current;
    const reported = reportedRef.current;
    if (detail?.status !== 'ready' || !list || !reported) return;
    // The list is `position: relative`, so `offsetTop` is measured from it.
    list.scrollTop = reported.offsetTop - (list.clientHeight - reported.clientHeight) / 2;
  }, [detail]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  async function decide() {
    if (!selected || !outcome) return;
    const index = items.findIndex((item) => item.id === selected.id);
    setBusy(true);
    setError(null);
    try {
      await decideChatReport(
        api,
        selected.id,
        // `action` only on an upheld report: on a rejection it would be a
        // punishment attached to a complaint just dismissed.
        outcome === 'upheld' ? { outcome, action, reason: reason.trim() } : { outcome, reason: reason.trim() },
      );
      setSelectedId(null);
      setDetail(null);
      resetDecision();
      focusIndexAfterLoad.current = index;
      await load();
    } catch (err) {
      setSelectedId(null);
      setDetail(null);
      resetDecision();
      // One refusal for missing, foreign, expired AND lost-the-race: say only
      // what it proves. Reload FIRST, then report — `load` clears the error.
      const message = isUnavailable(err)
        ? CHAT_REPORT_UNAVAILABLE
        : err instanceof Error
          ? err.message
          : 'ثبت تصمیم انجام نشد.';
      focusIndexAfterLoad.current = index;
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const reasonLength = reason.trim().length;
  const reasonTooShort = reasonLength < MIN_REASON;
  const thread = detail?.status === 'ready' ? detail.window : null;
  const canDecide = thread?.report.status === 'open';

  return (
    <div className={styles.page}>
      <PageHeader
        title="گزارش‌های گفتگو"
        subtitle="تنها راهِ دیدنِ یک گفتگو، گزارشی است که یکی از طرفینِ آن ثبت کرده. باز کردن هر گزارش در گزارش عملیات ثبت می‌شود."
      />

      <SegmentedControl
        label="وضعیت گزارش‌ها"
        value={filter}
        options={FILTERS}
        onChange={(value) => {
          setFilter(value);
          setSelectedId(null);
          setDetail(null);
          resetDecision();
        }}
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <div className={`${styles.layout} ${selected ? styles.withPanel : ''}`}>
        <section ref={queueRef} className={styles.queue} aria-labelledby={titleId}>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.sectionTitle}>
            {filter === 'open' ? 'گزارش‌های باز' : filter === 'upheld' ? 'گزارش‌های تأییدشده' : 'گزارش‌های ردشده'}
          </h2>
          {loading && !loaded ? (
            <LoadingState label="در حال بارگذاری صف…" lines={4} />
          ) : loaded && items.length === 0 ? (
            <EmptyState message="گزارشی در این فهرست نیست." />
          ) : loaded ? (
            <>
              <DataTable head={['کنش', 'دلیل', 'وضعیت', 'تاریخ گزارش', 'تصمیم']} aria-labelledby={titleId}>
                {items.map((item) => {
                  const date = formatZonedDateTime(new Date(item.createdAt));
                  const view = chatReportStatusView(item.status);
                  return (
                    <DataRow key={item.id} data-report={item.id} data-selected={item.id === selectedId || undefined}>
                      <DataCell label="کنش">
                        <Button
                          type="button"
                          variant="ghost"
                          inline
                          aria-expanded={item.id === selectedId}
                          aria-controls={panelId}
                          aria-label={`باز کردن گزارش «${chatReportReasonLabel(item.reason)}» از ${date}`}
                          onClick={() => open(item)}
                        >
                          باز کردن
                        </Button>
                      </DataCell>
                      <DataCell label="دلیل">{chatReportReasonLabel(item.reason)}</DataCell>
                      <DataCell label="وضعیت">
                        <Badge tone={view.tone}>{view.label}</Badge>
                      </DataCell>
                      <DataCell label="تاریخ گزارش">{date}</DataCell>
                      <DataCell label="تصمیم">
                        {item.decidedAt ? (
                          <>
                            {formatZonedDateTime(new Date(item.decidedAt))}
                            {item.decisionAction ? ` · ${chatActionLabel(item.decisionAction)}` : ''}
                          </>
                        ) : (
                          '—'
                        )}
                      </DataCell>
                    </DataRow>
                  );
                })}
              </DataTable>
              <p className={styles.count}>
                {toPersianDigits(items.length)} گزارش
                {items.length >= LIST_LIMIT ? ` — قدیمی‌ترین ${toPersianDigits(LIST_LIMIT)} گزارش نشان داده شده است` : ''}.
              </p>
            </>
          ) : null}
        </section>

        {selected ? (
          <section id={panelId} className={styles.panel} aria-labelledby={`${panelId}-title`} data-panel={selected.id}>
            <div className={styles.panelHead}>
              <h2 id={`${panelId}-title`} ref={panelHeadingRef} tabIndex={-1} className={styles.panelTitle}>
                گزارش {chatReportReasonLabel(selected.reason)}
              </h2>
              <Button type="button" variant="ghost" inline onClick={close} disabled={busy}>
                بستن
              </Button>
            </div>

            {detail?.status === 'loading' ? <LoadingState label="در حال بارگذاری گزارش…" lines={3} /> : null}
            {detail?.status === 'unavailable' ? <ErrorState message={CHAT_REPORT_UNREADABLE} onRetry={() => void load()} /> : null}
            {detail?.status === 'error' ? (
              <ErrorState message={detail.message} onRetry={() => void fetchWindow(selected.id)} />
            ) : null}

            {thread ? (
              <>
                <dl className={styles.meta}>
                  <div>
                    <dt>دلیل</dt>
                    <dd>{chatReportReasonLabel(thread.report.reason)}</dd>
                  </div>
                  <div>
                    <dt>وضعیت</dt>
                    <dd>
                      <Badge tone={chatReportStatusView(thread.report.status).tone}>
                        {chatReportStatusView(thread.report.status).label}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>تاریخ گزارش</dt>
                    <dd>{formatZonedDateTime(new Date(thread.report.createdAt))}</dd>
                  </div>
                  <div>
                    <dt>یادداشت گزارش‌دهنده</dt>
                    <dd>{thread.report.note ? <span className={styles.note}>{thread.report.note}</span> : 'بدون یادداشت'}</dd>
                  </div>
                </dl>

                <h3 className={styles.windowTitle}>پیام‌های پیرامون پیام گزارش‌شده</h3>
                <p className={styles.hint}>
                  حداکثر {toPersianDigits(WINDOW_MAX)} پیام. فرستنده‌ها فقط با بخشی از شناسه نشان داده می‌شوند. از اینجا نمی‌توان
                  پیامی فرستاد، ویرایش کرد یا حذف کرد.
                </p>
                <ol ref={messagesRef} className={styles.messages} aria-label="پیام‌های گفتگو" tabIndex={0}>
                  {thread.messages.slice(0, WINDOW_MAX).map((message) => {
                    const reported = message.id === thread.report.messageId;
                    return (
                      <li
                        key={message.id}
                        ref={reported ? reportedRef : undefined}
                        className={`${styles.message} ${reported ? styles.reported : ''}`}
                        data-message={message.id}
                        data-reported={reported || undefined}
                      >
                        <p className={styles.messageMeta}>
                          <span className={styles.sender}>{senderLabel(message.senderUserId)}</span>
                          <span> · {formatZonedDateTime(new Date(message.createdAt))}</span>
                          {reported ? <strong className={styles.reportedLabel}> · پیام گزارش‌شده</strong> : null}
                        </p>
                        {message.erased ? (
                          <p className={styles.erased}>این پیام پاک شده است.</p>
                        ) : (
                          <p className={styles.body}>{message.body}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>

                {canDecide ? (
                  <div className={styles.decision}>
                    <fieldset className={styles.outcomes}>
                      <legend className={styles.legend}>تصمیم</legend>
                      {(['upheld', 'rejected'] as const).map((value) => (
                        <label key={value} className={styles.radio}>
                          <input
                            type="radio"
                            name={`${panelId}-outcome`}
                            value={value}
                            checked={outcome === value}
                            onChange={() => setOutcome(value)}
                          />
                          <span>{value === 'upheld' ? 'تأیید گزارش' : 'رد گزارش'}</span>
                        </label>
                      ))}
                    </fieldset>

                    {outcome === 'upheld' ? (
                      <Select
                        label="اقدام"
                        value={action}
                        onChange={(e) => setAction(e.target.value as ChatModerationAction)}
                        hint={ACTION_CONSEQUENCE[action]}
                      >
                        {Object.entries(CHAT_ACTION_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    ) : null}

                    <Textarea
                      label="دلیل تصمیم"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={500}
                      hint="اجباری در هر دو تصمیم، حداقل ۳ نویسه. این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
                    />
                    {reasonLength > 0 && reasonTooShort ? (
                      <p className={styles.reasonError}>دلیل باید حداقل ۳ نویسه باشد.</p>
                    ) : null}

                    <Button
                      type="button"
                      inline
                      disabled={!outcome || reasonTooShort || busy}
                      onClick={() => setConfirming(true)}
                    >
                      ثبت تصمیم
                    </Button>
                  </div>
                ) : (
                  <p className={styles.hint}>
                    این گزارش پیش‌تر تصمیم‌گیری شده است
                    {selected.decisionAction ? ` (${chatActionLabel(selected.decisionAction)})` : ''}. گفتگوی گزارش‌های
                    تصمیم‌گیری‌شده تا ۳۰ روز پس از تصمیم خواندنی است.
                  </p>
                )}
              </>
            ) : null}
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        title={outcome === 'upheld' ? 'تأیید گزارش' : 'رد گزارش'}
        tone={outcome === 'upheld' && action !== 'warn_sender' ? 'danger' : 'primary'}
        confirmLabel="ثبت نهایی"
        busy={busy}
        confirmDisabled={reasonTooShort}
        describedById={`${panelId}-consequence`}
        onConfirm={() => void decide()}
        onCancel={() => setConfirming(false)}
        body={
          <p id={`${panelId}-consequence`} className={styles.dialogText}>
            {outcome === 'upheld'
              ? `${chatActionLabel(action)}: ${ACTION_CONSEQUENCE[action]}`
              : 'گزارش بسته می‌شود و هیچ اقدامی علیه فرستنده انجام نمی‌شود.'}
          </p>
        }
      />
    </div>
  );
}
