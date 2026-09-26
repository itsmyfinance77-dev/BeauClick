'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AI_MAX_INPUT_CHARACTERS,
  aiInputLength,
  isAcceptableAiInput,
  isUserResolvableRefusal,
  type AiConversationSummary,
  type AiMessageView,
  type AiProviderState,
  type AiQuotaView,
  type AiRecommendationView,
} from '@beauclick/ai-contract';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { aiApi, aiRefusalOf, isAccessWithdrawn, isConversationGone, type AiConversationDetail } from '@/lib/ai-api';
import { ApiRequestError } from '@/lib/api-client';
import styles from './assistant.module.css';

/**
 * The accepted state: the customer's conversations beside the open one.
 *
 * Everything drawn comes from a response field. A conversation has no title or
 * summary on the server (`AiConversationSummary`), so a row is its start time,
 * last activity, message count and status — nothing is generated to name it.
 * A recommendation card is `displayName` and `targetType` only; the assistant's
 * prose and the card are separate contracts and are never parsed into each
 * other.
 */

const GONE = 'این گفتگو دیگر در دسترس نیست.';

/** "۱٬۰۰۰" — grouped, Persian digits. */
function grouped(n: number): string {
  return toPersianDigits(new Intl.NumberFormat('en-US').format(n).replace(/,/g, '٬'));
}

function when(iso: string): string {
  return formatZonedDateTime(new Date(iso));
}

function statusLabel(c: AiConversationSummary): { text: string; tone: 'success' | 'neutral' } {
  if (c.status === 'active') return { text: 'فعال', tone: 'success' };
  if (c.closureReason === 'superseded') return { text: 'بسته — جایگزین‌شده', tone: 'neutral' };
  return { text: 'بسته — عدم فعالیت', tone: 'neutral' };
}

/** What produced an assistant bubble, said on the bubble itself (ADR-029 §4). */
const PROVIDER_LABEL: Record<AiProviderState, string> = {
  simulated: 'دستیار محلیِ آزمایشی — نه یک مدل زبانی',
  unavailable: 'پیام سامانه — دستیار پاسخ نداد',
  external: 'دستیار هوشمند',
};

type Thread =
  | { status: 'idle' }
  | { status: 'loading'; id: string }
  | { status: 'failed'; id: string; message: string }
  | { status: 'gone'; id: string }
  | { status: 'ready'; detail: AiConversationDetail };

export function AssistantWorkspace({
  onConsentRequired,
  onAccessWithdrawn,
}: {
  onConsentRequired: (message: string) => void;
  onAccessWithdrawn: () => void;
}) {
  const { api } = useAuth();

  // ------------------------------------------------------------ the list
  const [items, setItems] = useState<AiConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /**
   * A start refused for a reason the customer cannot fix by trying again
   * (`isUserResolvableRefusal` false — in practice `conversation_limit_reached`).
   * Every start control is disabled while it stands; deleting a conversation,
   * the refusal's own remedy, lifts it.
   */
  const [startBlocked, setStartBlocked] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // ------------------------------------------------------------ the thread
  const [thread, setThread] = useState<Thread>({ status: 'idle' });
  const [quota, setQuota] = useState<AiQuotaView | null>(null);
  const [exhausted, setExhausted] = useState<{ message: string; resetsAt: string | null } | null>(null);

  /** Routes the two page-level outcomes every request can produce. Returns true when handled. */
  const escalate = useCallback(
    (err: unknown): boolean => {
      if (isAccessWithdrawn(err)) {
        onAccessWithdrawn();
        return true;
      }
      const refusal = aiRefusalOf(err);
      if (refusal?.reason === 'consent_required') {
        onConsentRequired(refusal.message);
        return true;
      }
      return false;
    },
    [onAccessWithdrawn, onConsentRequired],
  );

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await aiApi.conversations(api);
      setItems(res.data?.items ?? []);
      setNextCursor(res.data?.nextCursor ?? null);
      setListLoaded(true);
    } catch (err) {
      if (!escalate(err)) setListError('فهرست گفتگوها بارگذاری نشد.');
    } finally {
      setListLoading(false);
    }
  }, [api, escalate]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function loadMore() {
    if (!nextCursor) return;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const res = await aiApi.conversations(api, nextCursor);
      setItems((current) => {
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...(res.data?.items ?? []).filter((c) => !seen.has(c.id))];
      });
      setNextCursor(res.data?.nextCursor ?? null);
    } catch (err) {
      if (!escalate(err)) setMoreError('صفحهٔ بعد بارگذاری نشد.');
    } finally {
      setMoreLoading(false);
    }
  }

  const open = useCallback(
    async (id: string) => {
      setThread({ status: 'loading', id });
      try {
        const res = await aiApi.conversation(api, id);
        if (res.data) setThread({ status: 'ready', detail: res.data });
        else setThread({ status: 'failed', id, message: 'گفتگو بارگذاری نشد.' });
      } catch (err) {
        if (escalate(err)) return;
        if (isConversationGone(err)) {
          setThread({ status: 'gone', id });
          setItems((current) => current.filter((c) => c.id !== id));
        } else {
          setThread({ status: 'failed', id, message: 'گفتگو بارگذاری نشد.' });
        }
      }
    },
    [api, escalate],
  );

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const res = await aiApi.start(api);
      const created = res.data;
      if (!created) throw new Error('empty');
      // Starting a conversation supersedes the active one on the server, so the
      // list is re-read rather than patched: the old row's status changed too.
      await loadList();
      setThread({ status: 'ready', detail: { conversation: created, messages: [] } });
      setAnnouncement('گفتگوی تازه شروع شد.');
    } catch (err) {
      if (escalate(err)) return;
      const refusal = aiRefusalOf(err);
      if (refusal && !isUserResolvableRefusal(refusal.reason)) setStartBlocked(refusal.message);
      else setStartError(refusal?.message ?? 'شروعِ گفتگو ممکن نشد. دوباره تلاش کنید.');
    } finally {
      setStarting(false);
    }
  }

  function updated(conversation: AiConversationSummary, appended: AiMessageView[]) {
    setThread((current) =>
      current.status === 'ready' && current.detail.conversation.id === conversation.id
        ? { status: 'ready', detail: { conversation, messages: [...current.detail.messages, ...appended] } }
        : current,
    );
    setItems((current) => current.map((c) => (c.id === conversation.id ? conversation : c)));
  }

  function removed(id: string) {
    setItems((current) => current.filter((c) => c.id !== id));
    setStartBlocked(null);
    setThread({ status: 'idle' });
    setAnnouncement('گفتگو برای همیشه حذف شد.');
  }

  const selectedId =
    thread.status === 'ready' ? thread.detail.conversation.id : thread.status === 'idle' ? null : thread.id;
  const empty = listLoaded && items.length === 0 && !nextCursor;

  return (
    <div className={styles.workspace} data-open={selectedId ? 'true' : 'false'}>
      <p className="bc-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <section className={styles.listPane} aria-labelledby="assistant-list-title">
        <div className={styles.listHeader}>
          <h2 id="assistant-list-title" className={styles.sectionTitle}>
            گفتگوهای شما
          </h2>
          {!empty ? (
            <Button
              type="button"
              variant="ghost"
              inline
              loading={starting}
              disabled={startBlocked !== null}
              onClick={() => void start()}
            >
              گفتگوی جدید
            </Button>
          ) : null}
        </div>
        {startBlocked ? <Alert>{startBlocked}</Alert> : startError ? <Alert>{startError}</Alert> : null}

        {listLoading && !listLoaded ? (
          <LoadingState label="در حال بارگذاری گفتگوها…" lines={3} />
        ) : listError && !listLoaded ? (
          <ErrorState message={listError} onRetry={() => void loadList()} />
        ) : empty ? (
          <EmptyState
            message="هنوز گفتگویی ندارید. هر سؤالی دربارهٔ خدمات و متخصص‌ها دارید بپرسید."
            action={
              <Button type="button" inline loading={starting} disabled={startBlocked !== null} onClick={() => void start()}>
                شروعِ گفتگو
              </Button>
            }
          />
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((c) => {
                const label = statusLabel(c);
                const current = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`${styles.row} ${current ? styles.rowCurrent : ''}`}
                      aria-current={current ? 'true' : undefined}
                      onClick={() => void open(c.id)}
                    >
                      <span className={styles.rowTitle}>گفتگو — شروع‌شده {when(c.startedAt)}</span>
                      <span className={styles.rowMeta}>
                        {grouped(c.messageCount)} پیام · فعالیتِ آخر: {when(c.lastActivityAt)}
                      </span>
                      <Badge tone={label.tone}>{label.text}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
            {nextCursor ? (
              <div className={styles.more}>
                {moreError ? <Alert>{moreError}</Alert> : null}
                <Button type="button" variant="ghost" inline loading={moreLoading} onClick={() => void loadMore()}>
                  {moreError ? 'تلاش دوباره' : 'بیشتر'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {selectedId ? (
        <section className={styles.threadPane} aria-label="گفتگوی باز">
          <button type="button" className={styles.back} onClick={() => setThread({ status: 'idle' })}>
            بازگشت به فهرست گفتگوها
          </button>
          {thread.status === 'loading' ? (
            <LoadingState label="در حال بارگذاری گفتگو…" lines={4} />
          ) : thread.status === 'failed' ? (
            <ErrorState message={thread.message} onRetry={() => void open(thread.id)} />
          ) : thread.status === 'gone' ? (
            <Alert tone="info">{GONE}</Alert>
          ) : thread.status === 'ready' ? (
            <ConversationView
              key={thread.detail.conversation.id}
              detail={thread.detail}
              quota={quota}
              exhausted={exhausted}
              starting={starting}
              startBlocked={startBlocked !== null}
              onStartNew={() => void start()}
              onExchanged={(exchange) => {
                updated(exchange.conversation, exchange.messages);
                setQuota(exchange.quota);
                if (exchange.quota.remaining <= 0) {
                  setExhausted({
                    message:
                      'سقف پیام‌های امروز شما با دستیار هوشمند تکمیل شده است. از نیمه‌شب (به وقتِ تهران) دوباره می‌توانید پیام بفرستید.',
                    resetsAt: exchange.quota.resetsAt,
                  });
                }
              }}
              onQuotaExhausted={(message, resetsAt) => setExhausted({ message, resetsAt })}
              onClosed={() => void open(thread.detail.conversation.id)}
              onGone={() => {
                const id = thread.detail.conversation.id;
                setThread({ status: 'gone', id });
                setItems((current) => current.filter((c) => c.id !== id));
              }}
              onDeleted={() => removed(thread.detail.conversation.id)}
              escalate={escalate}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ one conversation

interface Exchange {
  conversation: AiConversationSummary;
  messages: AiMessageView[];
  quota: AiQuotaView;
}

function ConversationView({
  detail,
  quota,
  exhausted,
  starting,
  startBlocked,
  onStartNew,
  onExchanged,
  onQuotaExhausted,
  onClosed,
  onGone,
  onDeleted,
  escalate,
}: {
  detail: AiConversationDetail;
  quota: AiQuotaView | null;
  exhausted: { message: string; resetsAt: string | null } | null;
  starting: boolean;
  startBlocked: boolean;
  onStartNew: () => void;
  onExchanged: (exchange: Exchange) => void;
  onQuotaExhausted: (message: string, resetsAt: string | null) => void;
  onClosed: () => void;
  onGone: () => void;
  onDeleted: () => void;
  escalate: (err: unknown) => boolean;
}) {
  const { api } = useAuth();
  const { conversation, messages } = detail;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const replyRef = useRef<HTMLElement | null>(null);
  const [focusReplyId, setFocusReplyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const titleId = useId();
  const consequenceId = useId();

  // Opening a conversation moves focus to its heading, so a keyboard or
  // screen-reader user lands on what they opened (list → conversation → composer).
  useEffect(() => {
    headingRef.current?.focus();
  }, [conversation.id]);

  // After a reply arrives, focus moves to the start of the assistant's message.
  useEffect(() => {
    if (focusReplyId) replyRef.current?.focus();
  }, [focusReplyId]);

  async function destroy() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await aiApi.destroy(api, conversation.id);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      if (escalate(err)) return;
      setDeleteError('حذف انجام نشد. دوباره تلاش کنید.');
    } finally {
      setDeleting(false);
    }
  }

  const status = statusLabel(conversation);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null;

  return (
    <article className={styles.conversation} aria-labelledby={titleId}>
      <header className={styles.conversationHeader}>
        <div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.sectionTitle}>
            گفتگو — شروع‌شده {when(conversation.startedAt)}
          </h2>
          <p className={styles.rowMeta}>
            {grouped(conversation.messageCount)} پیام · <Badge tone={status.tone}>{status.text}</Badge>
          </p>
        </div>
        <Button type="button" variant="danger" inline onClick={() => setConfirming(true)}>
          حذف
        </Button>
      </header>

      <div className={styles.log} role="log" aria-live="polite" aria-label="پیام‌های این گفتگو">
        {messages.length === 0 ? <p className={styles.logEmpty}>هنوز پیامی در این گفتگو نیست. پرسش خود را بنویسید.</p> : null}
        {messages.map((m) =>
          m.role === 'customer' ? (
            <div key={m.id} className={styles.bubbleCustomer} data-role="customer">
              <p className={styles.bubbleBody}>{m.body}</p>
            </div>
          ) : (
            <article
              key={m.id}
              ref={m.id === focusReplyId ? replyRef : undefined}
              tabIndex={m.id === lastAssistant ? -1 : undefined}
              className={styles.bubbleAssistant}
              data-role="assistant"
              data-provider-state={m.providerState ?? undefined}
              aria-label="پاسخ دستیار"
            >
              {m.providerState ? <p className={styles.providerLabel}>{PROVIDER_LABEL[m.providerState]}</p> : null}
              <p className={styles.bubbleBody}>{m.body}</p>
              {m.recommendations.length > 0 ? <Recommendations items={m.recommendations} /> : null}
            </article>
          ),
        )}
      </div>

      {conversation.status === 'closed' ? (
        <div className={styles.closed}>
          <Alert tone="info">
            {conversation.closureReason === 'superseded'
              ? 'این گفتگو با شروعِ گفتگویِ دیگری بسته شد و فقط‌خواندنی است.'
              : 'این گفتگو به‌دلیل عدم فعالیت در ۲۴ ساعتِ گذشته بسته شده و فقط‌خواندنی است.'}
          </Alert>
          <Button type="button" inline loading={starting} disabled={startBlocked} onClick={onStartNew}>
            شروعِ گفتگویِ جدید
          </Button>
        </div>
      ) : (
        <Composer
          conversationId={conversation.id}
          quota={quota}
          exhausted={exhausted}
          onExchanged={(exchange) => {
            onExchanged(exchange);
            const reply = exchange.messages.find((m) => m.role === 'assistant');
            if (reply) setFocusReplyId(reply.id);
          }}
          onQuotaExhausted={onQuotaExhausted}
          onClosed={onClosed}
          onGone={onGone}
          escalate={escalate}
        />
      )}

      <ConfirmDialog
        open={confirming}
        title="این گفتگو برای همیشه حذف شود؟"
        describedById={consequenceId}
        body={
          <>
            <p id={consequenceId}>همهٔ پیام‌ها و پیشنهادهایِ این گفتگو فوراً و برای همیشه حذف می‌شوند. بازیابی ممکن نیست.</p>
            {deleteError ? <Alert>{deleteError}</Alert> : null}
          </>
        }
        confirmLabel="حذفِ دائمی"
        tone="danger"
        busy={deleting}
        onConfirm={() => void destroy()}
        onCancel={() => {
          setConfirming(false);
          setDeleteError(null);
        }}
      />
    </article>
  );
}

/**
 * Cards from `AiRecommendationView` only. A professional links to its public
 * profile and records the click; a service has no page of its own and no public
 * route resolves a service id to its professional, so its card names it and
 * links nowhere rather than guessing a destination.
 */
function Recommendations({ items }: { items: readonly AiRecommendationView[] }) {
  const { api } = useAuth();
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return (
    <ul className={styles.recommendations} aria-label="پیشنهادها">
      {sorted.map((r) => (
        <li key={r.id} className={styles.card} data-target-type={r.targetType}>
          <span className={styles.cardKind}>{r.targetType === 'professional' ? 'متخصص' : 'خدمت'}</span>
          {r.targetType === 'professional' ? (
            <Link
              href={`/providers/${encodeURIComponent(r.targetId)}`}
              className={styles.cardName}
              // The beacon is best-effort: it measures whether the assistant
              // helped, and a failed one must never stop the customer arriving.
              onClick={() => void aiApi.recordClick(api, r.id).catch(() => undefined)}
            >
              {r.displayName}
            </Link>
          ) : (
            <span className={styles.cardName}>{r.displayName}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ the composer

function Composer({
  conversationId,
  quota,
  exhausted,
  onExchanged,
  onQuotaExhausted,
  onClosed,
  onGone,
  escalate,
}: {
  conversationId: string;
  quota: AiQuotaView | null;
  exhausted: { message: string; resetsAt: string | null } | null;
  onExchanged: (exchange: Exchange) => void;
  onQuotaExhausted: (message: string, resetsAt: string | null) => void;
  onClosed: () => void;
  onGone: () => void;
  escalate: (err: unknown) => boolean;
}) {
  const { api } = useAuth();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  /**
   * A send refused for a reason the customer cannot fix by editing and sending
   * again (`isUserResolvableRefusal` false). The contract makes that helper decide
   * whether the composer stays open, and here it does not: no field, no send
   * control, only the server's sentence — so the same request cannot simply be
   * sent again. Reopening the conversation later offers a fresh composer.
   */
  const [closedBy, setClosedBy] = useState<string | null>(null);
  const counterId = useId();
  const fieldId = useId();

  const length = aiInputLength(draft);
  const acceptable = isAcceptableAiInput(draft);
  const near = length > AI_MAX_INPUT_CHARACTERS * 0.9;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!acceptable || sending || exhausted) return;
    setSending(true);
    setError(null);
    try {
      const res = await aiApi.send(api, conversationId, draft);
      if (!res.data) throw new Error('empty');
      setDraft('');
      onExchanged(res.data);
    } catch (err) {
      if (escalate(err)) return;
      if (isConversationGone(err)) {
        onGone();
        return;
      }
      const refusal = aiRefusalOf(err);
      if (!refusal) {
        // A transport or server failure: the draft stays, and sending again is
        // a genuine retry of the same message.
        setError({
          message: err instanceof ApiRequestError && err.status === 0 ? err.message : 'ارسال پیام ناموفق بود.',
          retry: true,
        });
        return;
      }
      if (refusal.reason === 'quota_exhausted') {
        // Not resolvable either; its closed composer is page-wide, with the
        // server's reset instant.
        onQuotaExhausted(refusal.message, refusal.resetsAt);
        return;
      }
      if (refusal.reason === 'conversation_closed') {
        // Resolvable by starting a new one: the read-only state offers that.
        onClosed();
        return;
      }
      if (isUserResolvableRefusal(refusal.reason)) {
        // message_too_long: the draft stays, to be shortened and sent.
        setError({ message: refusal.message, retry: false });
        return;
      }
      // unsafe_request, assistant_unavailable: the composer closes. The refused
      // text is dropped and never shown back, and no answer is substituted.
      setDraft('');
      setClosedBy(refusal.message);
    } finally {
      setSending(false);
    }
  }

  if (closedBy) {
    return (
      <div className={styles.exhausted} data-testid="assistant-composer-closed">
        <Alert>{closedBy}</Alert>
      </div>
    );
  }

  if (exhausted) {
    return (
      <div className={styles.exhausted} role="status">
        <p className={styles.exhaustedText}>{exhausted.message}</p>
        {exhausted.resetsAt ? (
          <p className={styles.rowMeta}>زمانِ بازنشانی: {when(exhausted.resetsAt)} (به وقتِ تهران)</p>
        ) : null}
      </div>
    );
  }

  return (
    <form className={styles.composer} onSubmit={(e) => void submit(e)} noValidate>
      {error ? <Alert>{error.message}</Alert> : null}
      {/* A native field rather than the kit's `Textarea`, which owns
          `aria-describedby`: the live counter has to be tied to the field. */}
      <label htmlFor={fieldId} className={styles.fieldLabel}>
        پرسش شما
      </label>
      <textarea
        id={fieldId}
        className={styles.field}
        value={draft}
        rows={3}
        aria-describedby={counterId}
        aria-invalid={length > AI_MAX_INPUT_CHARACTERS || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      <div className={styles.composerFooter}>
        <span id={counterId} className={`${styles.counter} ${near ? styles.counterNear : ''}`}>
          {grouped(length)} / {grouped(AI_MAX_INPUT_CHARACTERS)} نویسه
          {length > AI_MAX_INPUT_CHARACTERS ? ' — طولانی‌تر از حد مجاز' : ''}
        </span>
        {quota ? (
          <span className={styles.rowMeta} data-testid="assistant-quota">
            امروز {grouped(quota.remaining)} پیام از {grouped(quota.limit)} باقی مانده
          </span>
        ) : null}
        <Button type="submit" inline loading={sending} disabled={!acceptable}>
          {error?.retry ? 'تلاش دوباره' : 'ارسال'}
        </Button>
      </div>
    </form>
  );
}
