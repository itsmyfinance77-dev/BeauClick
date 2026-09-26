'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_MAX_REPORT_NOTE_CHARACTERS,
  CHAT_POLL_LIST_MS,
  CHAT_POLL_THREAD_MS,
  CHAT_REPORT_REASONS,
  chatTextLength,
  isAcceptableChatMessage,
  isAcceptableReportNote,
  isRetryableAfterEditing,
  type ChatConversationSummary,
  type ChatMessageView,
  type ChatReportReason,
} from '@beauclick/chat-contract';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from './ui';
import { Badge, ConfirmDialog, EmptyState, TextLink } from './kit';
import { useAuth } from '@/lib/auth-context';
import { bookingApi } from '@/lib/booking-api';
import {
  chatApi,
  chatRefusalOf,
  isChatAccessWithdrawn,
  isChatGone,
  type ChatInboxFilter,
} from '@/lib/chat-api';
import { takePendingConversation } from '@/lib/chat-intent';
import {
  BUSINESS_COUNTERPARTY_LABEL,
  CHAT_GONE,
  CUSTOMER_LABEL,
  ERASED_AUTHOR,
  ERASED_MESSAGE,
  cannotSendCopy,
} from '@/lib/chat-labels';
import { announceChatUnread, usePoll } from '@/lib/chat-polling';
import { chatReportReasonLabel } from '@/lib/moderation-labels';
import styles from './chat-inbox.module.css';

/**
 * The participant inbox — `36_INTERNAL_CHAT.md`, `Prototype - Customer` §18 and
 * `Prototype - Pro and Admin` §17. One component, three routes: `/messages`
 * (the whole inbox), `/pro/messages` and `/business/messages` (the seller half,
 * narrowed by the server).
 *
 * Everything drawn is a response field. A summary carries no counterparty name,
 * no customer identity and no booking reference: a professional is named from
 * its public profile, a salon is the neutral «کسب‌وکار BeauClick» (no public
 * business summary exists), and a seller reads «مشتری» — the prototype's
 * «مشتری - رزرو ۱۲ مرداد» needs a booking reference the contract does not
 * carry, so it is not drawn.
 */

function grouped(n: number): string {
  return toPersianDigits(new Intl.NumberFormat('en-US').format(n).replace(/,/g, '٬'));
}

function when(iso: string): string {
  return formatZonedDateTime(new Date(iso));
}

/** Client-generated, reused by a retry of the same message (the server returns the original). */
function newIdempotencyKey(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// --------------------------------------------------------------- names

/** Professional display names, read once per id from the public profile. */
function useProfessionalNames() {
  const { api } = useAuth();
  const [names, setNames] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());

  const request = useCallback(
    (professionalId: string) => {
      if (asked.current.has(professionalId)) return;
      asked.current.add(professionalId);
      bookingApi
        .getProvider(api, professionalId)
        .then((res) => setNames((n) => ({ ...n, [professionalId]: res.data?.displayName ?? null })))
        .catch(() => setNames((n) => ({ ...n, [professionalId]: null })));
    },
    [api],
  );
  return { names, request };
}

type NameLookup = ReturnType<typeof useProfessionalNames>;

/** Who the OTHER side of a conversation is, as far as this reader may be told. */
function counterpartyLabel(c: ChatConversationSummary, lookup: NameLookup): string {
  if (c.side === 'seller') return CUSTOMER_LABEL;
  if (c.counterpartyType === 'business') return BUSINESS_COUNTERPARTY_LABEL;
  return lookup.names[c.counterpartyId] ?? 'متخصص';
}

/** For a seller row in the unified inbox: which of the reader's own parties it belongs to. */
function sellerRole(c: ChatConversationSummary): string {
  return c.counterpartyType === 'business' ? 'گفتگوی کسب‌وکار شما' : 'گفتگوی پروفایل متخصص شما';
}

// --------------------------------------------------------------- the inbox

export function ChatInbox({ filter, emptyAction }: { filter: ChatInboxFilter; emptyAction?: ReactNode }) {
  const { api } = useAuth();
  const lookup = useProfessionalNames();

  const [items, setItems] = useState<ChatConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // What is on screen, readable synchronously: a setState updater runs at
  // render time, so a value computed inside one is not there to be returned.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const side = filter.side;
  const counterpartyType = filter.counterpartyType;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await chatApi.conversations(api, { side, counterpartyType });
      setItems(res.data?.items ?? []);
      setNextCursor(res.data?.nextCursor ?? null);
      setLoaded(true);
    } catch (err) {
      if (isChatAccessWithdrawn(err)) setWithdrawn(true);
      else setError('بارگذاری گفتگوها ناموفق بود.');
    } finally {
      setLoading(false);
    }
  }, [api, side, counterpartyType]);

  useEffect(() => {
    void load();
    const pending = takePendingConversation();
    if (pending) setSelectedId(pending);
  }, [load]);

  // Names for the professional counterparties on screen.
  useEffect(() => {
    for (const c of items) if (c.side === 'customer' && c.counterpartyType === 'professional') lookup.request(c.counterpartyId);
  }, [items, lookup]);

  // The list polls its first page and merges it over what is loaded, so rows
  // from later pages stay and nothing moves under the reader except the order
  // and figures the server reports.
  usePoll(
    async () => {
      const res = await chatApi.conversations(api, { side, counterpartyType });
      const fresh = res.data?.items ?? [];
      const current = itemsRef.current;
      const freshIds = new Set(fresh.map((c) => c.id));
      const next = [...fresh, ...current.filter((c) => !freshIds.has(c.id))];
      const changed =
        next.length !== current.length ||
        next.some((c, i) => current[i]?.id !== c.id || current[i]?.lastMessageAt !== c.lastMessageAt || current[i]?.unreadCount !== c.unreadCount);
      if (changed) setItems(next);
      return changed;
    },
    CHAT_POLL_LIST_MS,
    loaded && !withdrawn,
  );

  async function loadMore() {
    if (!nextCursor) return;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const res = await chatApi.conversations(api, { side, counterpartyType }, nextCursor);
      setItems((current) => {
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...(res.data?.items ?? []).filter((c) => !seen.has(c.id))];
      });
      setNextCursor(res.data?.nextCursor ?? null);
    } catch {
      setMoreError('صفحهٔ بعد بارگذاری نشد.');
    } finally {
      setMoreLoading(false);
    }
  }

  function summaryChanged(summary: ChatConversationSummary) {
    setItems((current) => {
      const exists = current.some((c) => c.id === summary.id);
      return exists ? current.map((c) => (c.id === summary.id ? summary : c)) : [summary, ...current];
    });
  }

  function conversationGone(id: string) {
    setItems((current) => current.filter((c) => c.id !== id));
    setSelectedId(null);
    setGone(true);
  }

  if (withdrawn) return <Alert tone="info">دسترسی شما به گفتگوها دیگر فعال نیست.</Alert>;

  const empty = loaded && items.length === 0 && !nextCursor;
  const selected = items.find((c) => c.id === selectedId) ?? null;

  return (
    <div className={styles.workspace} data-open={selectedId ? 'true' : 'false'}>
      <p className="bc-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <section className={styles.listPane} aria-labelledby="chat-list-title">
        <h2 id="chat-list-title" className={styles.sectionTitle}>
          گفتگوها
        </h2>
        {gone ? <Alert tone="info">{CHAT_GONE}</Alert> : null}
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری گفتگوها…" lines={3} />
        ) : error && !loaded ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : empty ? (
          <EmptyState message="هنوز گفتگویی ندارید. گفتگو فقط از یک رزروِ تأییدشده باز می‌شود." action={emptyAction} />
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((c) => {
                const current = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`${styles.row} ${current ? styles.rowCurrent : ''}`}
                      aria-current={current ? 'true' : undefined}
                      data-side={c.side}
                      onClick={() => {
                        setGone(false);
                        setSelectedId(c.id);
                      }}
                    >
                      <span className={styles.rowTitle}>{counterpartyLabel(c, lookup)}</span>
                      {c.side === 'seller' && !filter.side ? <span className={styles.rowMeta}>{sellerRole(c)}</span> : null}
                      <span className={styles.rowMeta}>
                        {grouped(c.messageCount)} پیام
                        {c.lastMessageAt ? ` · آخرین فعالیت ${when(c.lastMessageAt)}` : ''}
                      </span>
                      <span className={styles.rowBadges}>
                        {c.unreadCount > 0 ? (
                          <span className={styles.unread}>{grouped(c.unreadCount)} خوانده‌نشده</span>
                        ) : null}
                        {!c.canSend ? <Badge tone="neutral">فقط‌خواندنی</Badge> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {nextCursor ? (
              <div className={styles.more}>
                {moreError ? <Alert>{moreError}</Alert> : null}
                <Button type="button" variant="ghost" inline loading={moreLoading} onClick={() => void loadMore()}>
                  {moreError ? 'تلاش دوباره' : 'بارگذاری موارد قبلی'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {selectedId ? (
        <section className={styles.threadPane} aria-label="گفتگوی باز">
          <button type="button" className={styles.back} onClick={() => setSelectedId(null)}>
            بازگشت به فهرست گفتگوها
          </button>
          <Thread
            key={selectedId}
            conversationId={selectedId}
            known={selected}
            lookup={lookup}
            onSummary={summaryChanged}
            onGone={() => conversationGone(selectedId)}
            onWithdrawn={() => setWithdrawn(true)}
            announce={setAnnouncement}
          />
        </section>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- a thread

function mergeMessages(current: ChatMessageView[], incoming: readonly ChatMessageView[]): ChatMessageView[] {
  const bySequence = new Map(current.map((m) => [m.sequence, m]));
  for (const m of incoming) bySequence.set(m.sequence, m);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

function Thread({
  conversationId,
  known,
  lookup,
  onSummary,
  onGone,
  onWithdrawn,
  announce,
}: {
  conversationId: string;
  known: ChatConversationSummary | null;
  lookup: NameLookup;
  onSummary: (summary: ChatConversationSummary) => void;
  onGone: () => void;
  onWithdrawn: () => void;
  announce: (text: string) => void;
}) {
  const { api } = useAuth();
  const [summary, setSummary] = useState<ChatConversationSummary | null>(known);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [blockDialog, setBlockDialog] = useState<'block' | 'unblock' | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<ChatMessageView | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /**
   * The read watermark, in two parts (Codex review of `76d6b9e`):
   *
   *   - `lastMarked`: the highest sequence the SERVER has confirmed as read.
   *     Advanced only by a successful `POST /read`, from its own answer.
   *   - `markingUpTo`: the highest sequence with a request in flight, 0 if none.
   *
   * A failed mark-read therefore leaves `lastMarked` where it was, and the next
   * poll (or the next load) asks again for the same sequence — the conversation
   * cannot stay unread because one request was lost. The in-flight marker stops
   * a second request for a sequence already being marked; the confirmed value
   * only ever grows, so an older response arriving late cannot move it back.
   * Nothing is decremented locally: the unread figures always come from the
   * server's answer and a re-read summary.
   */
  const lastMarked = useRef(0);
  const markingUpTo = useRef(0);
  /** The newest sequence present in this thread — read synchronously by the poll. */
  const newestSeen = useRef(0);
  const titleId = useId();

  const fail = useCallback(
    (err: unknown): boolean => {
      if (isChatGone(err)) {
        onGone();
        return true;
      }
      if (isChatAccessWithdrawn(err)) {
        onWithdrawn();
        return true;
      }
      return false;
    },
    [onGone, onWithdrawn],
  );

  const refreshSummary = useCallback(async () => {
    const res = await chatApi.conversation(api, conversationId);
    if (res.data) {
      setSummary(res.data);
      onSummary(res.data);
    }
  }, [api, conversationId, onSummary]);

  const markRead = useCallback(
    async (upTo: number) => {
      if (upTo <= lastMarked.current || upTo <= markingUpTo.current) return;
      markingUpTo.current = upTo;
      try {
        const res = await chatApi.markRead(api, conversationId, upTo);
        lastMarked.current = Math.max(lastMarked.current, res.data?.lastReadSequence ?? upTo);
        if (res.data) announceChatUnread(res.data.unread);
        await refreshSummary();
      } catch (err) {
        // Not confirmed: `lastMarked` is untouched, so the next poll retries.
        fail(err);
      } finally {
        if (markingUpTo.current === upTo) markingUpTo.current = 0;
      }
    },
    [api, conversationId, refreshSummary, fail],
  );

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [s, page] = await Promise.all([chatApi.conversation(api, conversationId), chatApi.messages(api, conversationId)]);
      if (s.data) {
        setSummary(s.data);
        onSummary(s.data);
      }
      const items = page.data?.items ?? [];
      setMessages(mergeMessages([], items));
      setNextBefore(page.data?.nextBeforeSequence ?? null);
      setStatus('ready');
      newestSeen.current = items.reduce((max, m) => Math.max(max, m.sequence), 0);
      if (newestSeen.current > 0) void markRead(newestSeen.current);
    } catch (err) {
      if (!fail(err)) setStatus('failed');
    }
  }, [api, conversationId, onSummary, fail, markRead]);

  // Only on opening a conversation: `load` is read through a ref so a new
  // `onSummary` from the parent does not reload the thread.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, [conversationId]);

  useEffect(() => {
    if (status === 'ready') headingRef.current?.focus();
  }, [status]);

  usePoll(
    async () => {
      try {
        const page = await chatApi.messages(api, conversationId);
        const items = page.data?.items ?? [];
        const newest = items.reduce((max, m) => Math.max(max, m.sequence), 0);
        const changed = newest > newestSeen.current;
        if (changed) {
          newestSeen.current = newest;
          setMessages((current) => mergeMessages(current, items));
        } else {
          // `canSend` can change with no new message: a block, a closure, the window.
          await refreshSummary();
        }
        // Also the RETRY path: anything seen but not yet confirmed read is asked
        // for again, whether or not this poll brought something new.
        if (newestSeen.current > lastMarked.current) void markRead(newestSeen.current);
        return changed;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    CHAT_POLL_THREAD_MS,
    status === 'ready',
  );

  async function loadOlder() {
    if (!nextBefore) return;
    setOlderLoading(true);
    setOlderError(null);
    try {
      const page = await chatApi.messages(api, conversationId, nextBefore);
      setMessages((current) => mergeMessages(current, page.data?.items ?? []));
      setNextBefore(page.data?.nextBeforeSequence ?? null);
    } catch (err) {
      if (!fail(err)) setOlderError('پیام‌های قبلی بارگذاری نشد.');
    } finally {
      setOlderLoading(false);
    }
  }

  async function changeBlock() {
    if (!blockDialog) return;
    setBlockBusy(true);
    setBlockError(null);
    try {
      if (blockDialog === 'block') await chatApi.block(api, conversationId);
      else await chatApi.unblock(api, conversationId);
      setBlockDialog(null);
      announce(blockDialog === 'block' ? 'مسدودسازی انجام شد.' : 'مسدودسازی لغو شد.');
      await refreshSummary();
    } catch (err) {
      if (fail(err)) return;
      setBlockError('انجام نشد. دوباره تلاش کنید.');
    } finally {
      setBlockBusy(false);
    }
  }

  if (status === 'loading' || !summary) return <LoadingState label="در حال بارگذاری گفتگو…" lines={4} />;
  if (status === 'failed') return <ErrorState message="بارگذاری گفتگو ناموفق بود." onRetry={() => void load()} />;

  const other = counterpartyLabel(summary, lookup);

  function authorOf(m: ChatMessageView): string {
    if (m.erased || m.side === null) return ERASED_AUTHOR;
    if (m.mine) return 'شما';
    if (m.side === summary!.side) return 'همکار شما';
    return other;
  }

  return (
    <article className={styles.conversation} aria-labelledby={titleId}>
      <header className={styles.conversationHeader}>
        <div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.sectionTitle}>
            {other}
          </h2>
          <p className={styles.rowMeta}>
            شروع {when(summary.startedAt)} · {grouped(summary.messageCount)} پیام
          </p>
        </div>
        {summary.blockedByMe ? (
          <Button type="button" variant="ghost" inline onClick={() => setBlockDialog('unblock')}>
            لغوِ مسدودسازی
          </Button>
        ) : (
          <Button type="button" variant="ghost" inline onClick={() => setBlockDialog('block')}>
            مسدودسازی
          </Button>
        )}
      </header>

      {nextBefore ? (
        <div className={styles.more}>
          {olderError ? <Alert>{olderError}</Alert> : null}
          <Button type="button" variant="ghost" inline loading={olderLoading} onClick={() => void loadOlder()}>
            {olderError ? 'تلاش دوباره' : 'پیام‌های قدیمی‌تر'}
          </Button>
        </div>
      ) : null}

      <div className={styles.log} role="log" aria-live="polite" aria-label="پیام‌های این گفتگو">
        {messages.length === 0 ? <p className={styles.logEmpty}>هنوز پیامی در این گفتگو نیست.</p> : null}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.erased ? styles.bubbleErased : m.mine || m.side === summary.side ? styles.bubbleOurs : styles.bubbleTheirs}
            data-sequence={m.sequence}
            data-mine={m.mine ? 'true' : 'false'}
          >
            <p className={styles.author}>
              {authorOf(m)} · <span className={styles.time}>{when(m.createdAt)}</span>
            </p>
            <p className={styles.body}>{m.erased || m.body === null ? ERASED_MESSAGE : m.body}</p>
            {!m.mine && !m.erased && m.side !== summary.side ? (
              <button type="button" className={styles.reportLink} onClick={() => setReporting(m)}>
                گزارشِ این پیام
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {summary.canSend ? (
        <Composer
          conversationId={conversationId}
          onSent={(message, next) => {
            setMessages((current) => mergeMessages(current, [message]));
            // Seen, not confirmed read: the poll marks it through the server.
            newestSeen.current = Math.max(newestSeen.current, message.sequence);
            setSummary(next);
            onSummary(next);
          }}
          onRefused={() => void refreshSummary()}
          fail={fail}
        />
      ) : (
        <div className={styles.readOnly} data-testid="chat-read-only">
          <Alert tone="info">{cannotSendCopy(summary.cannotSendReason ?? 'not_eligible', summary.side)}</Alert>
        </div>
      )}

      <ConfirmDialog
        open={blockDialog !== null}
        title={blockDialog === 'unblock' ? 'لغوِ مسدودسازی؟' : 'مسدودسازیِ این طرف؟'}
        body={
          <>
            <p>
              {blockDialog === 'unblock'
                ? 'ارسال دوباره فعال می‌شود، مگر آنکه مهلتِ ۹۰روزه در همین فاصله به پایان رسیده باشد.'
                : 'ارسال پیام برای هر دو طرف غیرفعال می‌شود. تاریخچهٔ گفتگو همچنان قابلِ‌خواندن می‌ماند. طرفِ مقابل هرگز از این مسدودسازی مطلع نمی‌شود.'}
            </p>
            {blockError ? <Alert>{blockError}</Alert> : null}
          </>
        }
        confirmLabel={blockDialog === 'unblock' ? 'لغوِ مسدودسازی' : 'مسدودسازی'}
        tone={blockDialog === 'unblock' ? 'primary' : 'danger'}
        busy={blockBusy}
        onConfirm={() => void changeBlock()}
        onCancel={() => {
          setBlockDialog(null);
          setBlockError(null);
        }}
      />

      {reporting ? (
        <ReportDialog
          conversationId={conversationId}
          message={reporting}
          onClose={() => setReporting(null)}
          onReported={() => {
            setReporting(null);
            announce('گزارش شما ثبت شد و بررسی می‌شود.');
          }}
          fail={fail}
        />
      ) : null}
    </article>
  );
}

// --------------------------------------------------------------- composer

function Composer({
  conversationId,
  onSent,
  onRefused,
  fail,
}: {
  conversationId: string;
  onSent: (message: ChatMessageView, summary: ChatConversationSummary) => void;
  onRefused: () => void;
  fail: (err: unknown) => boolean;
}) {
  const { api } = useAuth();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [closedBy, setClosedBy] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const fieldId = useId();
  const counterId = useId();

  const length = chatTextLength(draft);
  const acceptable = isAcceptableChatMessage(draft);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!acceptable || sending) return;
    setSending(true);
    setError(null);
    // One key per message: a retry of the same text after a transport failure
    // reuses it, and the server answers with the original instead of a second copy.
    key.current = key.current ?? newIdempotencyKey();
    try {
      const res = await chatApi.send(api, conversationId, draft, key.current);
      if (!res.data) throw new Error('empty');
      key.current = null;
      setDraft('');
      onSent(res.data.message, res.data.conversation);
    } catch (err) {
      if (fail(err)) return;
      const refusal = chatRefusalOf(err);
      if (!refusal) {
        // Never silently dropped: the text and its key stay for a genuine retry.
        setError({ message: 'ارسال پیام ناموفق بود.', retry: true });
        return;
      }
      key.current = null;
      if (isRetryableAfterEditing(refusal.reason)) {
        // message_too_long: the one refusal fixed by editing — the composer stays.
        setError({ message: refusal.message, retry: false });
        return;
      }
      // Everything else is a limit, a wait or a decision: the composer closes on
      // the server's sentence, and the summary is re-read (a block or closure
      // turns the thread read-only).
      setClosedBy(refusal.message);
      onRefused();
    } finally {
      setSending(false);
    }
  }

  if (closedBy) {
    return (
      <div className={styles.readOnly} data-testid="chat-composer-closed">
        <Alert>{closedBy}</Alert>
      </div>
    );
  }

  return (
    <form className={styles.composer} onSubmit={(e) => void submit(e)} noValidate>
      {error ? <Alert>{error.message}</Alert> : null}
      <label htmlFor={fieldId} className={styles.fieldLabel}>
        پیام شما
      </label>
      <textarea
        id={fieldId}
        className={styles.field}
        value={draft}
        rows={3}
        aria-describedby={counterId}
        aria-invalid={length > CHAT_MAX_MESSAGE_CHARACTERS || undefined}
        onChange={(e) => {
          // A different message is a different send: it gets its own key.
          if (key.current && e.target.value !== draft) key.current = null;
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      <div className={styles.composerFooter}>
        <span id={counterId} className={`${styles.counter} ${length > CHAT_MAX_MESSAGE_CHARACTERS * 0.9 ? styles.counterNear : ''}`}>
          {grouped(length)} / {grouped(CHAT_MAX_MESSAGE_CHARACTERS)} نویسه
          {length > CHAT_MAX_MESSAGE_CHARACTERS ? ' — طولانی‌تر از حد مجاز' : ''}
        </span>
        <Button type="submit" inline loading={sending} disabled={!acceptable}>
          {error?.retry ? 'تلاش دوباره' : 'ارسال'}
        </Button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------- report

function ReportDialog({
  conversationId,
  message,
  onClose,
  onReported,
  fail,
}: {
  conversationId: string;
  message: ChatMessageView;
  onClose: () => void;
  onReported: () => void;
  fail: (err: unknown) => boolean;
}) {
  const { api } = useAuth();
  const [reason, setReason] = useState<ChatReportReason>('harassment');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const reasonId = useId();
  const noteId = useId();
  const noteCounterId = useId();
  const descriptionId = useId();
  const noteLength = chatTextLength(note.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await chatApi.report(api, conversationId, message.id, reason, note.trim() || null);
      onReported();
    } catch (err) {
      if (fail(err)) return;
      const refusal = chatRefusalOf(err);
      if (refusal) {
        // report_already_open / report_rate_limited: a limit, not a typo — no resubmit.
        setError(refusal.message);
        setRefused(true);
      } else {
        setError('ثبت گزارش ناموفق بود. دوباره تلاش کنید.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      title="گزارشِ این پیام"
      describedById={descriptionId}
      body={
        <div className={styles.reportForm}>
          <p id={descriptionId} className={styles.rowMeta}>
            گزارش به تیم پشتیبانی می‌رسد. خودِ گفتگو با ثبتِ گزارش بسته یا پنهان نمی‌شود.
          </p>
          <label htmlFor={reasonId} className={styles.fieldLabel}>
            دلیل
          </label>
          <select id={reasonId} className={styles.field} value={reason} onChange={(e) => setReason(e.target.value as ChatReportReason)}>
            {CHAT_REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {chatReportReasonLabel(r)}
              </option>
            ))}
          </select>
          <label htmlFor={noteId} className={styles.fieldLabel}>
            توضیح (اختیاری)
          </label>
          <textarea
            id={noteId}
            className={styles.field}
            rows={3}
            value={note}
            aria-describedby={noteCounterId}
            aria-invalid={!isAcceptableReportNote(note) || undefined}
            onChange={(e) => setNote(e.target.value)}
          />
          <span id={noteCounterId} className={styles.counter}>
            {grouped(noteLength)} / {grouped(CHAT_MAX_REPORT_NOTE_CHARACTERS)} نویسه
          </span>
          {error ? <Alert>{error}</Alert> : null}
        </div>
      }
      confirmLabel="ارسالِ گزارش"
      tone="danger"
      busy={busy}
      confirmDisabled={refused || !isAcceptableReportNote(note)}
      onConfirm={() => void submit()}
      onCancel={onClose}
    />
  );
}

/** For the pages: a link to the bookings where a conversation can start. */
export function StartFromBookingsLink() {
  return <TextLink href="/bookings">رزروهای من</TextLink>;
}
