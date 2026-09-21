import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminChatReportsPage from '@/app/admin/chat-reports/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';
import { CHAT_REPORT_UNAVAILABLE, CHAT_REPORT_UNREADABLE } from '@/lib/moderation-labels';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/chat-reports',
}));

/**
 * `/admin/chat-reports`, against `37_ADMIN_CHAT_MODERATION.md`, where "the
 * absence is the control": no search, no id entry, no conversation browser; a
 * metadata-only queue; a bounded window whose senders are raw id fragments;
 * read and decide only; and one honest refusal for every unreachable report.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const notFound = () =>
  Promise.resolve({
    ok: false,
    status: 404,
    json: async () => ({ data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: 'این مورد یافت نشد.' } }),
  });

const R1 = '0191dddd-0001-7aaa-8bbb-000000000001';
const R2 = '0191dddd-0002-7aaa-8bbb-000000000002';
const SENDER_A = '0191eeee-aaaa-7bbb-8ccc-111111111111';
const SENDER_B = '0191ffff-bbbb-7ccc-8ddd-222222222222';
const CONVERSATION = '0191abab-cdcd-7efe-8fef-343434343434';

const OPEN = [
  // `note` and `body` are not on the real list response; they are here to prove the page would not show them.
  { id: R1, conversationId: CONVERSATION, reason: 'harassment', status: 'open', createdAt: '2026-09-15T06:30:00.000Z', decidedAt: null, decisionAction: null, note: 'یادداشت محرمانهٔ گزارش‌دهنده', body: 'متن پیام در فهرست' },
  { id: R2, conversationId: CONVERSATION, reason: 'off_platform_payment', status: 'open', createdAt: '2026-09-16T06:30:00.000Z', decidedAt: null, decisionAction: null },
];
const UPHELD = [{ id: R2, conversationId: CONVERSATION, reason: 'spam', status: 'upheld', createdAt: '2026-09-01T06:30:00.000Z', decidedAt: '2026-09-02T06:30:00.000Z', decisionAction: 'close_conversation' }];

function thread(reportId: string, status = 'open', count = 60) {
  return {
    report: { id: reportId, conversationId: CONVERSATION, messageId: 'm24', reason: 'harassment', note: 'مرا تهدید کرد', status, createdAt: '2026-09-15T06:30:00.000Z' },
    messages: Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      senderUserId: i % 2 ? SENDER_A : SENDER_B,
      body: i === 30 ? '' : `پیام ${i}`,
      erased: i === 30,
      sequence: i + 1,
      createdAt: '2026-09-15T06:00:00.000Z',
    })),
    windowLimit: 50,
  };
}

function mockApi({
  capabilities = ['bc_moderate_chat'],
  list = (status: string) => ok({ items: status === 'upheld' ? UPHELD : OPEN }),
  read = (id: string) => ok(thread(id)),
  decide = () => ok({ id: R1, status: 'rejected', decisionAction: null, decidedAt: null }),
}: {
  capabilities?: string[];
  list?: (status: string) => Promise<unknown>;
  read?: (id: string) => Promise<unknown>;
  decide?: () => Promise<unknown>;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'ناظر', roles: [], capabilities });
    if (url.includes('/decide')) return decide();
    const one = url.match(/\/v1\/admin\/chat\/reports\/([^/?]+)$/);
    if (one) return read(one[1]);
    if (url.includes('/v1/admin/chat/reports')) return list(new URL(url).searchParams.get('status') ?? 'open');
    return ok([]);
  });
}

const requests = () =>
  (global.fetch as jest.Mock).mock.calls
    .map(([url, init]: [string, RequestInit | undefined]) => ({ url: String(url), method: init?.method ?? 'GET', body: init?.body }))
    .filter((r) => r.url.includes('/v1/admin/'));
const reads = () => requests().filter((r) => /\/v1\/admin\/chat\/reports\/[^/?]+$/.test(r.url));
const decisions = () => requests().filter((r) => r.url.endsWith('/decide')).map((r) => JSON.parse(String(r.body)));

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminChatReportsPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-report="${id}"]`) as HTMLElement;
const panel = () => document.querySelector('[data-panel]') as HTMLElement;

async function openReport(user: ReturnType<typeof userEvent.setup>, id: string) {
  await screen.findByRole('table');
  await user.click(within(row(id)).getByRole('button', { name: /^باز کردن گزارش/ }));
  return panel();
}

async function openWindow(user: ReturnType<typeof userEvent.setup>, id: string) {
  const opened = await openReport(user, id);
  await within(opened).findByRole('list', { name: 'پیام‌های گفتگو' });
  return opened;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses everyone without `bc_moderate_chat` — a platform operator and a media or review moderator included', async () => {
    mockApi({ capabilities: ['bc_manage_platform', 'bc_moderate_verification', 'bc_moderate_media', 'bc_moderate_reviews'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(requests()).toHaveLength(0);
  });
});

describe('the absence is the control', () => {
  it('offers no search and no way to enter an id — the only entry is a report in the queue', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('searchbox')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryAllByRole('spinbutton')).toEqual([]);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('lists metadata only: no reporter’s note, no message body, no conversation id — and reads nothing until a report is opened', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row(R1)).getByText('آزار و مزاحمت')).toBeInTheDocument();
    expect(within(row(R2)).getByText('پرداخت بیرون از پلتفرم')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('یادداشت محرمانهٔ گزارش‌دهنده');
    expect(text).not.toContain('متن پیام در فهرست');
    expect(text).not.toContain(CONVERSATION.slice(0, 8));
    expect(reads()).toHaveLength(0);
  });

  it('reads one report only when a moderator opens it, and shows its note there', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    expect(reads().map((r) => r.url)).toEqual([expect.stringContaining(`/v1/admin/chat/reports/${R1}`)]);
    expect(within(opened).getByText('مرا تهدید کرد')).toBeInTheDocument();
    expect(within(opened).getByRole('heading', { level: 2 })).toHaveFocus();
  });
});

describe('the window', () => {
  it('shows at most fifty messages, even if more arrive', async () => {
    mockApi({ read: (id) => ok(thread(id, 'open', 60)) });
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    expect(within(within(opened).getByRole('list', { name: 'پیام‌های گفتگو' })).getAllByRole('listitem')).toHaveLength(50);
  });

  it('names a sender only by a short raw id fragment — never the full id, a name, or a link', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    const list = within(opened).getByRole('list', { name: 'پیام‌های گفتگو' });
    expect(within(list).getAllByText(`کاربر ${SENDER_A.slice(0, 8)}`).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(SENDER_A);
    expect(within(list).queryAllByRole('link')).toEqual([]);
    expect(list.querySelectorAll('img')).toHaveLength(0);
  });

  it('offers no send, edit or delete: nothing in the window can be acted on', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    const list = within(opened).getByRole('list', { name: 'پیام‌های گفتگو' });
    expect(within(list).queryAllByRole('button')).toEqual([]);
    expect(list.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('marks the reported message in words, and an erased one as erased', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    const reported = opened.querySelector('[data-reported]') as HTMLElement;
    expect(reported).toHaveAttribute('data-message', 'm24');
    expect(reported).toHaveTextContent('پیام گزارش‌شده');
    expect((opened.querySelector('[data-message="m30"]') as HTMLElement).textContent).toContain('این پیام پاک شده است.');
  });

  it('says a report cannot be read in the one honest sentence, whatever the reason', async () => {
    mockApi({ read: () => notFound() });
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, R1);
    expect(await within(opened).findByText(CHAT_REPORT_UNREADABLE)).toBeInTheDocument();
  });
});

describe('deciding', () => {
  it('waits for an outcome and a three-character reason, and offers an action only on an upheld report', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    const submit = within(opened).getByRole('button', { name: 'ثبت تصمیم' });
    expect(submit).toBeDisabled();
    expect(within(opened).queryByLabelText('اقدام')).toBeNull();
    // Neither outcome is chosen for the moderator.
    within(opened).getAllByRole('radio').forEach((radio) => expect(radio).not.toBeChecked());

    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'abc');
    // A good reason is not enough on its own: an outcome must be chosen too.
    expect(submit).toBeDisabled();
    await user.clear(within(opened).getByLabelText('دلیل تصمیم'));

    await user.click(within(opened).getByLabelText('رد گزارش'));
    expect(within(opened).queryByLabelText('اقدام')).toBeNull();
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), ' ab ');
    // Two characters once trimmed: under the server's three.
    expect(submit).toBeDisabled();
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'c');
    expect(submit).toBeEnabled();

    await user.click(within(opened).getByLabelText('تأیید گزارش'));
    expect(within(opened).getByLabelText('اقدام')).toHaveValue('warn_sender');
  });

  it('sends a rejection with no action at all — no punishment attached to a dismissed complaint', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    await user.click(within(opened).getByLabelText('رد گزارش'));
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), '  شواهدی نیست  ');
    await user.click(within(opened).getByRole('button', { name: 'ثبت تصمیم' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ثبت نهایی' }));

    await waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toEqual({ outcome: 'rejected', reason: 'شواهدی نیست' });
  });

  it('says what an upheld action does before it is sent, and sends the chosen action', async () => {
    let decided = false;
    mockApi({
      list: () => ok({ items: decided ? OPEN.slice(1) : OPEN }),
      decide: () => {
        decided = true;
        return ok({ id: R1, status: 'upheld', decisionAction: 'close_conversation', decidedAt: null });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    await user.click(within(opened).getByLabelText('تأیید گزارش'));
    await user.selectOptions(within(opened).getByLabelText('اقدام'), 'close_conversation');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'تهدید آشکار');
    await user.click(within(opened).getByRole('button', { name: 'ثبت تصمیم' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleDescription(/برای همیشه برای ارسال پیام بسته می‌شود/);
    await user.click(within(dialog).getByRole('button', { name: 'ثبت نهایی' }));

    await waitFor(() => expect(row(R1)).toBeNull());
    expect(decisions()).toEqual([{ outcome: 'upheld', action: 'close_conversation', reason: 'تهدید آشکار' }]);
    await waitFor(() => expect(within(row(R2)).getByRole('button')).toHaveFocus());
  });

  it('meets a refused decision with the honest sentence — after the reload, and never “a colleague decided it”', async () => {
    mockApi({ decide: () => notFound() });
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    await user.click(within(opened).getByLabelText('رد گزارش'));
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'دلیل');
    await user.click(within(opened).getByRole('button', { name: 'ثبت تصمیم' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ثبت نهایی' }));

    expect(await screen.findByText(CHAT_REPORT_UNAVAILABLE)).toBeInTheDocument();
    expect(requests().filter((r) => /\/v1\/admin\/chat\/reports\?/.test(r.url))).toHaveLength(2);
  });

  it('offers no decision on a report already decided, and shows what was decided', async () => {
    mockApi({ read: (id) => ok(thread(id, 'upheld')) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'تأییدشده' }));
    await waitFor(() => expect(row(R2)).not.toBeNull());
    expect(within(row(R2)).getByText(/بستن گفتگو برای ارسال/)).toBeInTheDocument();

    const opened = await openWindow(user, R2);
    expect(within(opened).queryByRole('button', { name: 'ثبت تصمیم' })).toBeNull();
    expect(within(opened).queryByRole('radio')).toBeNull();
  });

  it('only ever reads, and writes nothing but a decision', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWindow(user, R1);
    await user.click(within(opened).getByLabelText('رد گزارش'));
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'دلیل');
    await user.click(within(opened).getByRole('button', { name: 'ثبت تصمیم' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ثبت نهایی' }));
    await waitFor(() => expect(decisions()).toHaveLength(1));

    const writes = requests().filter((r) => r.method !== 'GET');
    expect(writes.map((r) => r.url)).toEqual([expect.stringMatching(new RegExp(`/v1/admin/chat/reports/${R1}/decide$`))]);
  });
});
