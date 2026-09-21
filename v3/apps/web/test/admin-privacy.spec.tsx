import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPrivacyPage from '@/app/admin/privacy/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/privacy',
}));

/**
 * `/admin/privacy`, against `31_ADMIN_PRIVACY_QUEUE.md`: a monitor, not a
 * control. One read route, a status filter, pagination — and structurally
 * nothing else: no download, no cancel, no row that opens.
 */

const ok = (data: unknown, meta: unknown = null) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code: 'ERR', message } }) });

const SUBJECT = '0191cccc-dddd-7eee-8fff-000011112222';
const base = { completedAt: null, cancelledAt: null, failureCode: null, executeAfter: null, expiresAt: null };
const ROWS = [
  { ...base, id: 'pr-1', subjectUserId: SUBJECT, kind: 'erasure', status: 'pending', requestedAt: '2026-09-15T06:30:00.000Z', executeAfter: '2026-09-22T06:30:00.000Z' },
  { ...base, id: 'pr-2', subjectUserId: '0191cccc-aaaa-7eee-8fff-999988887777', kind: 'export', status: 'ready', requestedAt: '2026-09-14T06:30:00.000Z', expiresAt: '2026-09-21T06:30:00.000Z', completedAt: '2026-09-14T07:00:00.000Z', failureCode: 'stale_code_from_retry' },
  { ...base, id: 'pr-3', subjectUserId: '0191cccc-bbbb-7eee-8fff-555544443333', kind: 'export', status: 'failed', requestedAt: '2026-09-13T06:30:00.000Z', failureCode: 'export_generation_failed' },
  // A field the route never returns, to prove the page renders only what the spec lists.
  { ...base, id: 'pr-4', subjectUserId: '0191cccc-eeee-7eee-8fff-121212121212', kind: 'erasure', status: 'archived', requestedAt: '2026-09-12T06:30:00.000Z', phone: '+989121234567' },
];

function mockApi({
  capabilities = ['bc_manage_platform'],
  list = () => ok(ROWS, { pagination: { page: 1, limit: 20, total: 45 } }),
}: { capabilities?: string[]; list?: (url: string) => Promise<unknown> } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities });
    if (url.includes('/v1/admin/privacy/requests')) return list(url);
    return ok([]);
  });
}

const listCalls = () =>
  (global.fetch as jest.Mock).mock.calls
    .map(([url]: [string]) => String(url))
    .filter((url) => url.includes('/v1/admin/privacy/requests'))
    .map((url) => new URL(url).searchParams);

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminPrivacyPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-request="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a content moderator — this is the operational tier, not moderation', async () => {
    mockApi({ capabilities: ['bc_moderate_reviews', 'bc_moderate_media', 'bc_moderate_chat'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(listCalls()).toHaveLength(0);
  });
});

describe('a monitor, not a control', () => {
  it('says so in a note, in words, not only in colour', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole('note')).toHaveTextContent('این صفحه فقط وضعیت را نشان می‌دهد. دانلودِ داده یا لغوِ حذف از اینجا ممکن نیست.');
  });

  it('has no action anywhere in the table: no button, no link, no focusable row', async () => {
    mockApi();
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(within(table).queryAllByRole('link')).toEqual([]);
    expect(table.querySelectorAll('[tabindex], [onclick]')).toHaveLength(0);
  });

  it('offers no download and no cancel on the page, and only ever reads', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));

    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['صفحهٔ قبل', 'صفحهٔ بعد']);
    const methods = (global.fetch as jest.Mock).mock.calls
      .filter(([url]: [string]) => String(url).includes('/v1/admin/'))
      .map(([, init]: [string, RequestInit]) => init?.method ?? 'GET');
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });
});

describe('the rows', () => {
  it('shows the subject shortened and left-to-right, never in full', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('pr-1')).getByText(SUBJECT.slice(0, 8))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SUBJECT);
  });

  it('shows the grace window for an erasure and the expiry for an export', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(row('pr-1').textContent).toContain('اجرا پس از');
    expect(row('pr-2').textContent).toContain('انقضا');
  });

  it('shows the failure code on a failed request, and nothing where there is none', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('pr-3')).getByText('export_generation_failed')).toBeInTheDocument();
    expect(within(row('pr-1')).queryByText(/_failed/)).toBeNull();
    // A code left on a request that has since succeeded is not a failure to follow up.
    expect(row('pr-2').textContent).not.toContain('stale_code_from_retry');
    expect(within(row('pr-2')).getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('names statuses and kinds in Persian, with a neutral word for one it does not know, and renders no field beyond the spec’s', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('pr-1')).getByText('در انتظار')).toBeInTheDocument();
    expect(within(row('pr-1')).getByText('حذف حساب')).toBeInTheDocument();
    expect(within(row('pr-2')).getByText('دریافت نسخهٔ داده')).toBeInTheDocument();
    expect(within(row('pr-4')).getByText('نامشخص')).toBeInTheDocument();
    expect(row('pr-4').textContent).not.toContain('archived');
    expect(document.body.textContent).not.toContain('989121234567');
  });
});

describe('filter and pages', () => {
  it('filters by status on the server, from the first page', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }));
    await waitFor(() => expect(listCalls().at(-1)?.get('page')).toBe('2'));

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'failed');
    await waitFor(() => expect(listCalls().at(-1)?.get('status')).toBe('failed'));
    expect(listCalls().at(-1)?.get('page')).toBe('1');

    await user.selectOptions(screen.getByLabelText('وضعیت'), '');
    await waitFor(() => expect(listCalls().at(-1)?.has('status')).toBe(false));
  });

  it('has no filter by kind — the route cannot filter by it (#266), and a page filtered in the browser would lie about the totals', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(listCalls().every((params) => !params.has('kind'))).toBe(true);
  });

  it('pages with the server’s total, and stops at either end', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    expect(screen.getByText(/صفحهٔ ۱ از ۳/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'صفحهٔ قبل' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }));
    await screen.findByText(/صفحهٔ ۲ از ۳/);
    await user.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }));
    await screen.findByText(/صفحهٔ ۳ از ۳/);
    expect(screen.getByRole('button', { name: 'صفحهٔ بعد' })).toBeDisabled();
    expect(listCalls().map((params) => params.get('page'))).toEqual(['1', '2', '3']);
  });
});

describe('states', () => {
  it('says so when there is nothing to show', async () => {
    mockApi({ list: () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }) });
    renderPage();
    expect(await screen.findByText('صفی برای نشان‌دادن نیست.')).toBeInTheDocument();
  });

  it('does not call a failed load an empty queue, and offers a retry', async () => {
    mockApi({ list: () => fail(500, 'خطای سرور') });
    renderPage();
    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    expect(screen.queryByText('صفی برای نشان‌دادن نیست.')).toBeNull();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});
