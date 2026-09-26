import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_POLL_IDLE_MS,
  CHAT_POLL_THREAD_MS,
  type ChatConversationSummary,
  type ChatMessageView,
} from '@beauclick/chat-contract';
import MessagesPage from '@/app/messages/page';
import ProMessagesPage from '@/app/pro/messages/page';
import BusinessMessagesPage from '@/app/business/messages/page';
import { AuthProvider } from '@/lib/auth-context';
import { setPendingConversation } from '@/lib/chat-intent';
import { nextPollDelay } from '@/lib/chat-polling';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/messages',
}));

/**
 * The participant inbox (`36_INTERNAL_CHAT.md`, #328) against a fake of the
 * `/v1/chat/*` contract. The rule under test throughout: nothing is drawn that
 * the server did not return — no counterparty name it did not serve, no
 * customer identity, no booking reference — and every refusal the server
 * RETURNS is shown in its own sentence, keyed on `details.reason`.
 */

const PRO = 'pro-1';
const BIZ = 'biz-1';

function conv(id: string, over: Partial<ChatConversationSummary> = {}): ChatConversationSummary {
  return {
    id,
    side: 'customer',
    counterpartyType: 'professional',
    counterpartyId: PRO,
    messageCount: 2,
    unreadCount: 0,
    lastMessageAt: '2026-09-25T07:00:00.000Z',
    startedAt: '2026-09-20T06:30:00.000Z',
    canSend: true,
    cannotSendReason: null,
    closedReason: null,
    blockedByMe: false,
    ...over,
  };
}

function msg(sequence: number, over: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: `m${sequence}`,
    mine: false,
    side: 'seller',
    body: `پیام ${sequence}`,
    erased: false,
    sequence,
    createdAt: '2026-09-25T07:00:00.000Z',
    ...over,
  };
}

type Reply = { status: number; data?: unknown; error?: { code: string; message: string; details?: unknown } };
type Handler = (url: string, init: RequestInit | undefined) => Reply | Promise<Reply>;
const ok = (data: unknown, status = 200): Reply => ({ status, data });
const refused = (status: number, reason: string, message: string): Reply => ({
  status,
  error: { code: 'CHAT_REFUSED', message, details: { reason } },
});
const notFound: Reply = { status: 404, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: 'یافت نشد.' } };

interface Routes {
  capabilities?: string[];
  list?: Handler;
  summary?: Handler;
  messages?: Handler;
  send?: Handler;
  read?: Handler;
  block?: Handler;
  report?: Handler;
  provider?: Handler;
}

let networkFail: RegExp | null = null;

function respond(reply: Reply | 'network') {
  if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => ({ data: reply.data ?? null, meta: null, error: reply.error ?? null }),
  });
}

function mockApi(routes: Routes = {}) {
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (networkFail?.test(`${method} ${url}`)) return respond('network');
    if (url.includes('/v1/auth/refresh')) return respond(ok({ accessToken: 'a', csrfToken: 'c' }));
    if (/\/v1\/me(\?|$)/.test(url)) {
      return respond(ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: routes.capabilities ?? ['bc_use_chat'] }));
    }
    const pick = (h: Handler | undefined, fallback: Reply) => (h ? h(url, init) : fallback);
    if (url.includes('/v1/providers/')) return respond(await pick(routes.provider, ok({ id: PRO, displayName: 'سالن آرا' })));
    if (/\/v1\/chat\/conversations(\?|$)/.test(url) && method === 'GET') return respond(await pick(routes.list, ok({ items: [], nextCursor: null })));
    if (/\/messages(\?|$)/.test(url) && method === 'GET') return respond(await pick(routes.messages, ok({ items: [], nextBeforeSequence: null })));
    if (/\/messages$/.test(url) && method === 'POST') return respond(await pick(routes.send, notFound));
    if (/\/read$/.test(url)) return respond(await pick(routes.read, ok({ lastReadSequence: 0, unread: { total: 0, conversations: 0 } })));
    if (/\/block$/.test(url)) return respond(await pick(routes.block, { status: 204 }));
    if (/\/report$/.test(url)) return respond(await pick(routes.report, ok({ id: 'r1' }, 201)));
    if (/\/v1\/chat\/conversations\/[^/?]+$/.test(url) && method === 'GET') return respond(await pick(routes.summary, notFound));
    if (url.includes('/v1/chat/unread-count')) return respond(ok({ total: 0, conversations: 0 }));
    return respond(ok([]));
  });
}

function calls(fragment: string, method = 'GET') {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]: [string, RequestInit | undefined]) => String(url).includes(fragment) && (init?.method ?? 'GET') === method,
  );
}

function bodyOf(call: [string, RequestInit | undefined]) {
  return JSON.parse(String(call[1]?.body));
}

const renderPage = (Page: () => JSX.Element = MessagesPage) =>
  render(
    <AuthProvider>
      <Page />
    </AuthProvider>,
  );

/** A single conversation, openable, with a thread. */
function oneThread(over: Partial<ChatConversationSummary> = {}, messages: ChatMessageView[] = [msg(1, { mine: true, side: 'customer' }), msg(2)], extra: Routes = {}) {
  const summary = conv('c1', over);
  mockApi({
    list: () => ok({ items: [summary], nextCursor: null }),
    summary: () => ok(summary),
    messages: () => ok({ items: [...messages].reverse(), nextBeforeSequence: null }),
    ...extra,
  });
  return summary;
}

async function openFirst(user: ReturnType<typeof userEvent.setup>) {
  const rows = await screen.findAllByRole('button', { name: /پیام/ });
  const row = rows.find((b) => b.closest('li'))!;
  await user.click(row);
  return screen.findByRole('log', { name: 'پیام‌های این گفتگو' });
}

beforeEach(() => {
  networkFail = null;
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------- who reaches it

describe('who reaches it', () => {
  it('tells a session without bc_use_chat so, and sends not one chat request', async () => {
    mockApi({ capabilities: [] });
    renderPage();
    expect(await screen.findByText('گفتگو برای حساب شما فعال نیست.')).toBeInTheDocument();
    expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('/v1/chat/'))).toBe(false);
  });

  it('says access is no longer active on a plain 403 — distinct from any chat refusal', async () => {
    mockApi({ list: () => ({ status: 403, error: { code: 'FORBIDDEN', message: 'x' } }) });
    renderPage();
    expect(await screen.findByText('دسترسی شما به گفتگوها دیگر فعال نیست.')).toBeInTheDocument();
  });

  it('asks the server for the seller half on the professional and business pages, and the whole inbox on /messages', async () => {
    mockApi();
    const first = renderPage();
    await screen.findByText(/هنوز گفتگویی ندارید/);
    first.unmount();
    renderPage(ProMessagesPage);
    await waitFor(() => expect(calls('side=seller&counterpartyType=professional').length).toBeGreaterThan(0));
    renderPage(BusinessMessagesPage);
    await waitFor(() => expect(calls('side=seller&counterpartyType=business').length).toBeGreaterThan(0));
    expect(calls('/v1/chat/conversations').some(([url]: [string]) => String(url).endsWith('/v1/chat/conversations'))).toBe(true);
  });
});

// ---------------------------------------------------------------- the list

describe('the inbox list', () => {
  it('is an honest empty state that says where a conversation starts', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText(/گفتگو فقط از یک رزروِ تأییدشده باز می‌شود/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'رزروهای من' })).toHaveAttribute('href', '/bookings');
  });

  it('shows a retryable error when the list cannot be read — never the empty state', async () => {
    mockApi({ list: () => ({ status: 500, error: { code: 'INTERNAL_ERROR', message: 'x' } }) });
    renderPage();
    expect(await screen.findByText('بارگذاری گفتگوها ناموفق بود.')).toBeInTheDocument();
    expect(screen.queryByText(/هنوز گفتگویی ندارید/)).toBeNull();
  });

  it('labels each row only from the server: a professional by its public name, a salon neutrally, a seller-side row as «مشتری»', async () => {
    mockApi({
      list: () =>
        ok({
          items: [
            conv('c1', { unreadCount: 2 }),
            conv('c2', { counterpartyType: 'business', counterpartyId: BIZ, canSend: false, cannotSendReason: 'send_window_closed' }),
            conv('c3', { side: 'seller', counterpartyType: 'business', counterpartyId: BIZ }),
          ],
          nextCursor: null,
        }),
    });
    renderPage();
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('button');
    await waitFor(() => expect(rows[0]).toHaveTextContent('سالن آرا'));
    expect(rows[0]).toHaveTextContent('۲ خوانده‌نشده');
    expect(rows[1]).toHaveTextContent('کسب‌وکار BeauClick');
    expect(rows[1]).toHaveTextContent('فقط‌خواندنی');
    expect(rows[2]).toHaveTextContent('مشتری');
    expect(rows[2]).toHaveTextContent('گفتگوی کسب‌وکار شما');
    // The salon's id is never printed, and no invented salon name appears.
    expect(list.textContent).not.toContain(BIZ);
  });

  it('draws no professional name it was not served — the fallback is the kind, not a guess', async () => {
    mockApi({ list: () => ok({ items: [conv('c1')], nextCursor: null }), provider: () => ({ status: 500, error: { code: 'X', message: 'x' } }) });
    renderPage();
    const list = await screen.findByRole('list');
    await waitFor(() => expect(calls('/v1/providers/').length).toBeGreaterThan(0));
    expect(within(list).getByRole('button')).toHaveTextContent('متخصص');
  });

  it('pages by the server`s cursor', async () => {
    mockApi({
      list: (url) =>
        url.includes('cursor=')
          ? ok({ items: [conv('c2', { counterpartyType: 'business', counterpartyId: BIZ })], nextCursor: null })
          : ok({ items: [conv('c1')], nextCursor: 'CUR/1' }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'بارگذاری موارد قبلی' }));
    await waitFor(() => expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2));
    expect(calls('cursor=CUR%2F1').length).toBe(1);
  });
});

// ---------------------------------------------------------------- the thread

describe('a conversation', () => {
  it('shows messages oldest first in a polite log, with who wrote each, and focuses its heading', async () => {
    oneThread({}, [msg(1, { mine: true, side: 'customer' }), msg(2), msg(3, { mine: true, side: 'customer', body: 'سوم' })]);
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    expect(log).toHaveAttribute('aria-live', 'polite');
    const bubbles = [...log.querySelectorAll('[data-sequence]')].map((b) => b.getAttribute('data-sequence'));
    expect(bubbles).toEqual(['1', '2', '3']);
    expect(within(log).getAllByText(/^شما ·/)).toHaveLength(2);
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
  });

  it('draws an erased author as a neutral placeholder with no text, and a seller colleague as a colleague', async () => {
    oneThread({ side: 'seller', counterpartyType: 'business', counterpartyId: BIZ }, [
      msg(1, { side: 'customer', body: 'سؤال' }),
      msg(2, { side: 'seller', mine: false, body: 'پاسخ همکار' }),
      msg(3, { side: null, erased: true, body: null }),
    ]);
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    expect(within(log).getByText('این پیام حذف شده است.')).toBeInTheDocument();
    expect(within(log).getByText(/کاربر حذف‌شده/)).toBeInTheDocument();
    expect(within(log).getByText(/همکار شما/)).toBeInTheDocument();
    expect(within(log).getByText(/^مشتری ·/)).toBeInTheDocument();
  });

  it('marks what was read up to the newest sequence, and re-reads the server`s unread figure', async () => {
    oneThread({ unreadCount: 1 });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    await waitFor(() => expect(calls('/v1/chat/conversations/c1/read', 'POST')).toHaveLength(1));
    expect(bodyOf(calls('/v1/chat/conversations/c1/read', 'POST')[0])).toEqual({ upToSequence: 2 });
  });

  it('loads older messages by sequence, never by offset', async () => {
    oneThread({}, [], {
      messages: (url) =>
        url.includes('before=')
          ? ok({ items: [msg(1)], nextBeforeSequence: null })
          : ok({ items: [msg(3), msg(2)], nextBeforeSequence: 2 }),
    });
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    await user.click(screen.getByRole('button', { name: 'پیام‌های قدیمی‌تر' }));
    await waitFor(() => expect(log.querySelectorAll('[data-sequence]')).toHaveLength(3));
    expect(calls('messages?before=2').length).toBe(1);
  });

  it('says a gone conversation is gone — one sentence for deleted, foreign or access lost — and drops the row', async () => {
    mockApi({ list: () => ok({ items: [conv('c1')], nextCursor: null }), summary: () => notFound });
    const user = userEvent.setup();
    renderPage();
    const rows = await screen.findAllByRole('button', { name: /پیام/ });
    await user.click(rows.find((b) => b.closest('li'))!);
    expect(await screen.findByText('این گفتگو دیگر در دسترس نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('opens the conversation a booking just started, without it ever being in the URL', async () => {
    oneThread();
    setPendingConversation('c1');
    renderPage();
    expect(await screen.findByRole('log', { name: 'پیام‌های این گفتگو' })).toBeInTheDocument();
    expect(window.location.href).not.toContain('c1');
  });
});

// ---------------------------------------------------------------- sending

describe('the composer', () => {
  it('counts code points against the contract`s limit and cannot send an empty or over-long message', async () => {
    oneThread();
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    const field = screen.getByLabelText('پیام شما');
    expect(screen.getByRole('button', { name: 'ارسال' })).toBeDisabled();
    await user.type(field, 'سلام 👋');
    expect(field).toHaveAccessibleDescription(/۶ \/ ۲٬۰۰۰ نویسه/);
    await user.clear(field);
    await user.click(field);
    await user.paste('ا'.repeat(CHAT_MAX_MESSAGE_CHARACTERS + 1));
    expect(screen.getByRole('button', { name: 'ارسال' })).toBeDisabled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends with a client idempotency key, appends the message and clears the draft', async () => {
    oneThread({}, [msg(1)], {
      send: (_url, init) => {
        const { body } = JSON.parse(String(init?.body));
        return ok({ message: msg(2, { mine: true, side: 'customer', body }), conversation: conv('c1', { messageCount: 2 }) }, 201);
      },
    });
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    await user.type(screen.getByLabelText('پیام شما'), 'سلام');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));
    expect(await within(log).findByText('سلام')).toBeInTheDocument();
    expect(screen.getByLabelText('پیام شما')).toHaveValue('');
    const sent = bodyOf(calls('/v1/chat/conversations/c1/messages', 'POST')[0]);
    expect(sent.body).toBe('سلام');
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(sent.idempotencyKey.length).toBeGreaterThanOrEqual(16);
  });

  it('keeps a failed message and its key, so the retry cannot create a second copy', async () => {
    oneThread({}, [msg(1)], {
      send: (_url, init) => ok({ message: msg(2, { mine: true, side: 'customer', body: JSON.parse(String(init?.body)).body }), conversation: conv('c1') }, 201),
    });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    networkFail = /POST .*\/messages$/;
    await user.type(screen.getByLabelText('پیام شما'), 'سلام');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));
    expect(await screen.findByText('ارسال پیام ناموفق بود.')).toBeInTheDocument();
    expect(screen.getByLabelText('پیام شما')).toHaveValue('سلام');
    const firstKey = bodyOf(calls('/messages', 'POST')[0]).idempotencyKey;
    networkFail = null;
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    await waitFor(() => expect(calls('/messages', 'POST')).toHaveLength(2));
    expect(bodyOf(calls('/messages', 'POST')[1]).idempotencyKey).toBe(firstKey);
  });

  it('keeps the composer for message_too_long, the one refusal fixed by editing', async () => {
    oneThread({}, [msg(1)], { send: () => refused(400, 'message_too_long', 'پیام شما خالی است یا از حد مجاز طولانی‌تر است.') });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    await user.type(screen.getByLabelText('پیام شما'), 'متن');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));
    expect(await screen.findByText('پیام شما خالی است یا از حد مجاز طولانی‌تر است.')).toBeInTheDocument();
    expect(screen.getByLabelText('پیام شما')).toHaveValue('متن');
    expect(screen.getByRole('button', { name: 'ارسال' })).toBeEnabled();
  });

  it('closes the composer on a refusal that is a limit, not a typo — no ordinary send control remains', async () => {
    const sentence = 'تعداد پیام‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.';
    oneThread({}, [msg(1)], { send: () => refused(429, 'rate_limited', sentence) });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    await user.type(screen.getByLabelText('پیام شما'), 'سلام');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByLabelText('پیام شما')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ارسال' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    expect(calls('/messages', 'POST')).toHaveLength(1);
  });

  it.each([
    ['send_window_closed', 'customer', 'مهلت ارسال پیام برای این گفتگو به پایان رسیده است. با ثبت رزرو جدید دوباره می‌توانید پیام بفرستید.'],
    ['send_window_closed', 'seller', 'مهلت ارسال پیام برای این گفتگو به پایان رسیده است.'],
    ['blocked', 'customer', 'امکان ارسال پیام در این گفتگو وجود ندارد.'],
    ['blocked', 'seller', 'امکان ارسال پیام در این گفتگو وجود ندارد.'],
    ['conversation_closed', 'customer', 'این گفتگو توسط تیم پشتیبانی بسته شده است و امکان ارسال پیام تازه ندارد.'],
    ['sender_restricted', 'customer', 'امکان ارسال پیام برای حساب شما محدود شده است.'],
  ] as const)('draws %s for a %s reader as read-only, with no composer', async (reason, side, copy) => {
    oneThread({ canSend: false, cannotSendReason: reason, side });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    expect(within(screen.getByTestId('chat-read-only')).getByText(copy)).toBeInTheDocument();
    expect(screen.queryByLabelText('پیام شما')).toBeNull();
  });
});

// ---------------------------------------------------------------- block and report

describe('blocking and reporting', () => {
  it('blocks only after a confirmation that says the other side is never told, then offers unblock to the blocker', async () => {
    let blocked = false;
    const user = userEvent.setup();
    mockApi({
      list: () => ok({ items: [conv('c1')], nextCursor: null }),
      summary: () => ok(conv('c1', blocked ? { blockedByMe: true, canSend: false, cannotSendReason: 'blocked' } : {})),
      messages: () => ok({ items: [msg(1)], nextBeforeSequence: null }),
      block: () => {
        blocked = true;
        return { status: 204 };
      },
    });
    renderPage();
    await openFirst(user);
    await user.click(screen.getByRole('button', { name: 'مسدودسازی' }));
    const dialog = screen.getByRole('dialog', { name: 'مسدودسازیِ این طرف؟' });
    expect(dialog).toHaveTextContent('طرفِ مقابل هرگز از این مسدودسازی مطلع نمی‌شود.');
    expect(calls('/block', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'مسدودسازی' }));
    expect(await screen.findByRole('button', { name: 'لغوِ مسدودسازی' })).toBeInTheDocument();
    expect(calls('/v1/chat/conversations/c1/block', 'POST')).toHaveLength(1);
  });

  it('offers the blocked party no unblock — the refusal alone, no direction', async () => {
    oneThread({ blockedByMe: false, canSend: false, cannotSendReason: 'blocked' });
    const user = userEvent.setup();
    renderPage();
    await openFirst(user);
    expect(screen.queryByRole('button', { name: 'لغوِ مسدودسازی' })).toBeNull();
  });

  it('reports one message of the other side with one of the seven reasons, and never a message of one`s own', async () => {
    oneThread({}, [msg(1, { mine: true, side: 'customer' }), msg(2)]);
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    // Only the other side's message carries the control.
    expect(within(log).getAllByRole('button', { name: 'گزارشِ این پیام' })).toHaveLength(1);
    await user.click(within(log).getByRole('button', { name: 'گزارشِ این پیام' }));
    const dialog = screen.getByRole('dialog', { name: 'گزارشِ این پیام' });
    expect(within(dialog).getAllByRole('option')).toHaveLength(7);
    await user.selectOptions(within(dialog).getByLabelText('دلیل'), 'off_platform_payment');
    await user.type(within(dialog).getByLabelText('توضیح (اختیاری)'), 'درخواست کارت به کارت');
    await user.click(within(dialog).getByRole('button', { name: 'ارسالِ گزارش' }));
    await waitFor(() => expect(calls('/report', 'POST')).toHaveLength(1));
    expect(bodyOf(calls('/report', 'POST')[0])).toEqual({ messageId: 'm2', reason: 'off_platform_payment', note: 'درخواست کارت به کارت' });
    expect(await screen.findByText('گزارش شما ثبت شد و بررسی می‌شود.')).toBeInTheDocument();
  });

  it('shows report_already_open in the server`s words and offers no resubmission', async () => {
    const sentence = 'گزارش قبلی شما برای این گفتگو هنوز در حال بررسی است.';
    oneThread({}, [msg(1)], { report: () => refused(409, 'report_already_open', sentence) });
    const user = userEvent.setup();
    renderPage();
    const log = await openFirst(user);
    await user.click(within(log).getByRole('button', { name: 'گزارشِ این پیام' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'ارسالِ گزارش' }));
    expect(await within(dialog).findByText(sentence)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'ارسالِ گزارش' })).toBeDisabled();
  });
});

// ---------------------------------------------------------------- the read watermark

/**
 * Codex review of `76d6b9e`: the watermark was advanced BEFORE `POST /read`
 * succeeded, so one lost request left an open conversation unread until a
 * newer message arrived. The confirmed value now moves only on the server's
 * answer; a failure is retried by the next poll for the same sequence.
 */
describe('the read watermark', () => {
  const serverError: Reply = { status: 500, error: { code: 'INTERNAL_ERROR', message: 'x' } };

  async function openWithFakeTimers(routes: Routes) {
    jest.useFakeTimers();
    mockApi({ list: () => ok({ items: [conv('c1', { unreadCount: 1 })], nextCursor: null }), ...routes });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderPage();
    const log = await openFirst(user);
    return { user, log };
  }

  const tick = () =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(CHAT_POLL_THREAD_MS + 50);
    });

  it('retries a failed mark-read for the same sequence on the next poll, then takes the unread figures from the server', async () => {
    let reads = 0;
    let confirmed = false;
    const announced: number[] = [];
    const listener = (e: Event) => announced.push((e as CustomEvent<{ total: number }>).detail.total);
    window.addEventListener('bc:chat-unread', listener);
    try {
      await openWithFakeTimers({
        summary: () => ok(conv('c1', { unreadCount: confirmed ? 0 : 1 })),
        messages: () => ok({ items: [msg(2), msg(1, { mine: true, side: 'customer' })], nextBeforeSequence: null }),
        read: () => {
          reads += 1;
          if (reads === 1) return serverError;
          confirmed = true;
          return ok({ lastReadSequence: 2, unread: { total: 0, conversations: 0 } });
        },
      });
      await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(1));
      // The failure changed nothing locally: still unread, nothing announced.
      expect(announced).toEqual([]);
      expect(within(screen.getByRole('list')).getByRole('button')).toHaveTextContent('۱ خوانده‌نشده');

      await tick();
      await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(2));
      expect(calls('/read', 'POST').map(bodyOf)).toEqual([{ upToSequence: 2 }, { upToSequence: 2 }]);
      // The server's figures, not a local decrement.
      await waitFor(() => expect(announced).toEqual([0]));
      await waitFor(() => expect(within(screen.getByRole('list')).getByRole('button')).not.toHaveTextContent('خوانده‌نشده'));

      // Confirmed: the next quiet poll asks nothing more.
      await tick();
      expect(calls('/read', 'POST')).toHaveLength(2);
    } finally {
      window.removeEventListener('bc:chat-unread', listener);
    }
  });

  it('sends no second mark-read for a sequence already in flight', async () => {
    let release: (reply: Reply) => void = () => undefined;
    await openWithFakeTimers({
      summary: () => ok(conv('c1')),
      messages: () => ok({ items: [msg(2), msg(1)], nextBeforeSequence: null }),
      read: () => new Promise<Reply>((resolve) => (release = resolve)),
    });
    await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(1));
    await tick();
    await tick();
    expect(calls('/read', 'POST')).toHaveLength(1);
    await act(async () => release(ok({ lastReadSequence: 2, unread: { total: 0, conversations: 0 } })));
  });

  it('marks read a message that arrives by polling', async () => {
    let newest = 1;
    await openWithFakeTimers({
      summary: () => ok(conv('c1')),
      messages: () => ok({ items: Array.from({ length: newest }, (_, i) => msg(newest - i)), nextBeforeSequence: null }),
      read: (_url, init) => ok({ lastReadSequence: JSON.parse(String(init?.body)).upToSequence, unread: { total: 0, conversations: 0 } }),
    });
    await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(1));
    newest = 2;
    await tick();
    await waitFor(() => expect(calls('/read', 'POST').map(bodyOf)).toEqual([{ upToSequence: 1 }, { upToSequence: 2 }]));
  });

  it('does not let one`s own sent message stand in for a read the server never confirmed', async () => {
    let reads = 0;
    const { user } = await openWithFakeTimers({
      summary: () => ok(conv('c1')),
      messages: () => ok({ items: [msg(2), msg(1)], nextBeforeSequence: null }),
      read: () => {
        reads += 1;
        return reads === 1 ? serverError : ok({ lastReadSequence: 3, unread: { total: 0, conversations: 0 } });
      },
      send: () => ok({ message: msg(3, { mine: true, side: 'customer', body: 'سلام' }), conversation: conv('c1', { messageCount: 3 }) }, 201),
    });
    await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(1));
    await user.type(screen.getByLabelText('پیام شما'), 'سلام');
    await user.click(screen.getByRole('button', { name: 'ارسال' }));
    await waitFor(() => expect(calls('/messages', 'POST')).toHaveLength(1));
    await tick();
    // The unconfirmed read is still asked for — now up to the newest seen.
    await waitFor(() => expect(calls('/read', 'POST')).toHaveLength(2));
    expect(bodyOf(calls('/read', 'POST')[1]).upToSequence).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- polling

describe('polling — the transport', () => {
  it('backs off to the idle interval after five quiet polls, or at once while hidden', () => {
    expect(nextPollDelay(CHAT_POLL_THREAD_MS, 0, false)).toBe(CHAT_POLL_THREAD_MS);
    expect(nextPollDelay(CHAT_POLL_THREAD_MS, 4, false)).toBe(CHAT_POLL_THREAD_MS);
    expect(nextPollDelay(CHAT_POLL_THREAD_MS, 5, false)).toBe(CHAT_POLL_IDLE_MS);
    expect(nextPollDelay(CHAT_POLL_THREAD_MS, 0, true)).toBe(CHAT_POLL_IDLE_MS);
  });

  it('shows a message that arrives while the thread is open, on the next poll', async () => {
    jest.useFakeTimers();
    let newest = 1;
    mockApi({
      list: () => ok({ items: [conv('c1')], nextCursor: null }),
      summary: () => ok(conv('c1')),
      messages: () => ok({ items: Array.from({ length: newest }, (_, i) => msg(newest - i)), nextBeforeSequence: null }),
    });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    renderPage();
    const log = await openFirst(user);
    expect(log.querySelectorAll('[data-sequence]')).toHaveLength(1);
    newest = 2;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(CHAT_POLL_THREAD_MS + 50);
    });
    await waitFor(() => expect(log.querySelectorAll('[data-sequence]')).toHaveLength(2));
  });
});
