import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PrivacyPage from '@/app/account/privacy/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/account/privacy',
}));

/**
 * `/account/privacy`, against `29_PRIVACY_ACCOUNT.md`. Two decisions, two
 * cards: a copy of your data, and deleting your account after a window you can
 * cancel in. The things most worth pinning are the ones the spec warns about:
 * nothing may say deletion "cannot be undone", a "not found" is the server's
 * sentence and never a more precise one, and `DELETE` is typed exactly.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const accepted = (data: unknown) => Promise.resolve({ ok: true, status: 202, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const request = (over: Record<string, unknown>) => ({
  id: 'req-1',
  kind: 'export',
  status: 'pending',
  requestedAt: iso(-DAY),
  executeAfter: null,
  expiresAt: null,
  completedAt: null,
  cancelledAt: null,
  failureCode: null,
  ...over,
});

const DOCUMENT = {
  documentVersion: 1,
  subjectUserId: 'u1',
  generatedAt: '2026-09-21T09:00:00.000Z',
  sections: {
    'booking.bookings': { description: 'رزروهای شما', rows: [{ id: 'b1' }] },
    'loyalty.balance': { description: 'امتیاز باشگاه', rows: [] },
  },
  retained: [
    { module: 'financial', table: 'financial.ledger_entries', reason: 'append-only ledger' },
    { module: 'financial', table: 'financial.settlement_batches', reason: 'settlement record' },
    { module: 'analytics', table: 'analytics.daily_metrics', reason: 'aggregate only' },
  ],
};

interface Routes {
  list?: () => Promise<unknown>;
  requestExport?: () => Promise<unknown>;
  download?: () => Promise<unknown>;
  requestErasure?: () => Promise<unknown>;
  cancel?: () => Promise<unknown>;
}

function mockApi(routes: Routes = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: [] });
    if (url.includes('/v1/privacy/requests')) return routes.list ? routes.list() : ok([]);
    if (url.includes('/download')) return routes.download ? routes.download() : ok({ byteSize: 100, checksumSha256: 'x', expiresAt: iso(DAY), document: DOCUMENT });
    if (url.includes('/v1/privacy/export') && method === 'POST') return routes.requestExport ? routes.requestExport() : accepted(request({ status: 'pending' }));
    if (url.includes('/v1/privacy/deletion') && url.includes('/cancel')) return routes.cancel ? routes.cancel() : ok(request({ kind: 'erasure', status: 'cancelled' }));
    if (url.includes('/v1/privacy/deletion') && method === 'POST') {
      return routes.requestErasure ? routes.requestErasure() : accepted(request({ id: 'er-1', kind: 'erasure', status: 'pending', executeAfter: iso(7 * DAY) }));
    }
    return ok([]);
  });
}

const listOf = (...items: unknown[]) => () => ok(items);

function calls(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]: [string, RequestInit | undefined]) => String(url).includes(fragment) && (!method || (init?.method ?? 'GET').toUpperCase() === method),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <PrivacyPage />
    </AuthProvider>,
  );
}

const exportCard = () => screen.getByRole('region', { name: 'دریافت خروجی داده‌ها' });
const erasureCard = () => screen.getByRole('region', { name: 'حذف حساب' });

let saved: string[];

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
  saved = [];
  URL.createObjectURL = jest.fn(() => 'blob:mock');
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});

afterEach(() => jest.restoreAllMocks());

describe('the page', () => {
  it('is two separate cards with their own headings', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('region', { name: 'دریافت خروجی داده‌ها' });
    expect(screen.getByRole('heading', { name: 'حذف حساب' })).toBeInTheDocument();
  });

  it('offers a retry when the list fails to load, and shows neither card until it does', async () => {
    let attempt = 0;
    mockApi({ list: () => (++attempt === 1 ? fail(500, 'X', 'خطای سرور') : ok([])) });
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(screen.queryByRole('heading', { name: 'حذف حساب' })).toBeNull();
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: 'حذف حساب' })).toBeInTheDocument();
  });
});

describe('the export card', () => {
  it('asks for an export and re-reads the list', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'درخواست دریافت داده‌ها' }));
    await waitFor(() => expect(calls('/v1/privacy/export', 'POST')).toHaveLength(1));
    await waitFor(() => expect(calls('/v1/privacy/requests').length).toBeGreaterThanOrEqual(2));
  });

  it.each(['pending', 'processing'])('says a %s export is being prepared — one state to a person — and blocks a second request', async (status) => {
    mockApi({ list: listOf(request({ status })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'دریافت خروجی داده‌ها' });
    expect(within(card).getByText('درخواست شما در حال آماده‌سازی است.')).toHaveAttribute('role', 'status');
    expect(within(card).getByRole('button', { name: 'درخواست خروجی تازه' })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'دانلود فایل داده‌ها' })).toBeNull();
  });

  it('lets the customer check again without a second request', async () => {
    mockApi({ list: listOf(request({ status: 'pending' })) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'بررسی دوباره' }));
    await waitFor(() => expect(calls('/v1/privacy/requests').length).toBeGreaterThanOrEqual(2));
    expect(calls('/v1/privacy/export', 'POST')).toHaveLength(0);
  });

  it('offers the download of a ready export, and says exactly until when it is available', async () => {
    mockApi({ list: listOf(request({ status: 'ready', expiresAt: iso(3 * DAY) })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'دریافت خروجی داده‌ها' });
    const status = within(card).getByText(/فایل شما آماده است/);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/تا .+ در دسترس است/);
    expect(within(card).getByRole('button', { name: 'دانلود فایل داده‌ها' })).toBeEnabled();
  });

  it('saves the document from the browser — no signed link — and announces it', async () => {
    mockApi({ list: listOf(request({ status: 'ready', expiresAt: iso(3 * DAY) })) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'دانلود فایل داده‌ها' }));
    expect(await screen.findByText('فایل داده‌های شما ذخیره شد.')).toBeInTheDocument();
    expect(saved).toEqual(['beauclick-data-2026-09-21.json']);
    const blob = (URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(calls('/v1/privacy/export/req-1/download', 'GET')).toHaveLength(1);
  });

  it('then lists what the file holds and what is kept, as text a person can read', async () => {
    mockApi({ list: listOf(request({ status: 'ready', expiresAt: iso(3 * DAY) })) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'دانلود فایل داده‌ها' }));
    const card = exportCard();
    expect(await within(card).findByText('رزروهای شما')).toBeInTheDocument();
    expect(within(card).getByText('امتیاز باشگاه')).toBeInTheDocument();
    // Payment history: the spec's own plain sentence.
    expect(within(card).getByText(/سابقهٔ شما نگه داشته می‌شود چون قانوناً الزامی است/)).toBeInTheDocument();
    // Any other module: its Persian name and how many items — never an invented legal claim.
    expect(within(card).getByText(/آمار:/)).toBeInTheDocument();
    expect(within(card).getByText(/۱ مورد نگه داشته می‌شود/)).toBeInTheDocument();
    // The server's own reason is there to open, as the server wrote it.
    expect(within(card).getByText(/analytics\.daily_metrics — aggregate only/)).toBeInTheDocument();
    expect(card.textContent).not.toContain('"documentVersion"');
  });

  it('shows the server’s one sentence when the download is refused — never a more precise reason', async () => {
    mockApi({
      list: listOf(request({ status: 'ready', expiresAt: iso(3 * DAY) })),
      download: () => fail(404, 'NOT_FOUND_OR_NOT_YOURS', 'این درخواست یافت نشد.'),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'دانلود فایل داده‌ها' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('این درخواست یافت نشد.');
    expect(alert.textContent).not.toMatch(/منقضی|متعلق|آماده نشده/);
    expect(saved).toEqual([]);
  });

  it('treats an expired export as a normal ending, not an error, and offers a fresh request', async () => {
    mockApi({ list: listOf(request({ status: 'expired', expiresAt: iso(-DAY) })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'دریافت خروجی داده‌ها' });
    expect(within(card).getByText(/فایل شما دیگر در دسترس نیست/)).toHaveAttribute('role', 'status');
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(within(card).getByRole('button', { name: 'درخواست خروجی تازه' })).toBeEnabled();
  });

  it('says something went wrong for a failed export and offers a retry', async () => {
    mockApi({ list: listOf(request({ status: 'failed', failureCode: 'X' })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'دریافت خروجی داده‌ها' });
    expect(within(card).getByText(/مشکلی پیش آمد/)).toHaveAttribute('role', 'status');
    expect(within(card).getByRole('button', { name: 'تلاش دوباره' })).toBeEnabled();
    expect(card.textContent).not.toContain('X');
  });

  it('shows the server’s own sentence on a 409 and re-reads the list so the open request appears', async () => {
    let listed = 0;
    mockApi({
      list: () => (++listed === 1 ? ok([]) : ok([request({ status: 'pending' })])),
      requestExport: () => fail(409, 'CONFLICT', 'یک درخواست دریافت اطلاعات در حال انجام دارید.'),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'درخواست دریافت داده‌ها' }));
    expect(await screen.findByText('یک درخواست دریافت اطلاعات در حال انجام دارید.')).toBeInTheDocument();
    expect(await screen.findByText('درخواست شما در حال آماده‌سازی است.')).toBeInTheDocument();
  });
});

describe('the deletion card', () => {
  it('explains the window and what stays, and never says it cannot be undone', async () => {
    mockApi();
    renderPage();
    const card = await screen.findByRole('region', { name: 'حذف حساب' });
    expect(card).toHaveTextContent('پنجرهٔ هفت‌روزه');
    expect(card).toHaveTextContent('هر لحظه');
    expect(card).toHaveTextContent('سابقهٔ پرداخت شما');
    expect(document.body.textContent).not.toMatch(/برگشت‌?ناپذیر|قابل\s?بازگشت نیست|غیرقابل\s?بازگشت|بازگشت ندارد/);
  });

  it('cannot be started without typing DELETE exactly — case, spaces and translation all refuse', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'شروع حذف حساب' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'شروع حذف' });
    const input = within(dialog).getByLabelText(/عبارت DELETE را تایپ کنید/);
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(confirm).toBeDisabled();
    for (const wrong of ['delete', 'DELETE ', ' DELETE', 'حذف', 'DELET']) {
      await user.clear(input);
      await user.type(input, wrong);
      expect(confirm).toBeDisabled();
    }
    await user.clear(input);
    await user.type(input, 'DELETE');
    expect(confirm).toBeEnabled();
    expect(calls('/v1/privacy/deletion', 'POST')).toHaveLength(0);
  });

  it('sends the typed confirmation, closes the dialog, and shows the exact date it will run', async () => {
    let listed = 0;
    mockApi({
      list: () => (++listed === 1 ? ok([]) : ok([request({ id: 'er-1', kind: 'erasure', status: 'pending', executeAfter: iso(7 * DAY - 3600_000) })])),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'شروع حذف حساب' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/عبارت DELETE را تایپ کنید/), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'شروع حذف' }));

    await waitFor(() => expect(calls('/v1/privacy/deletion', 'POST')).toHaveLength(1));
    expect(JSON.parse(calls('/v1/privacy/deletion', 'POST')[0][1].body)).toEqual({ confirm: 'DELETE' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const card = erasureCard();
    expect(await within(card).findByText(/اجرا می‌شود/)).toHaveAttribute('role', 'status');
  });

  it('shows the date, the days that remain and a cancel button for an open request — and keeps the account usable', async () => {
    mockApi({ list: listOf(request({ id: 'er-1', kind: 'erasure', status: 'pending', executeAfter: iso(3.5 * DAY) })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'حذف حساب' });
    const status = within(card).getByText(/اجرا می‌شود/);
    expect(status).toHaveTextContent('۴ روز دیگر');
    expect(status).toHaveTextContent('کاملاً قابل‌استفاده');
    expect(within(card).getByRole('button', { name: 'لغو درخواست حذف' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: 'شروع حذف حساب' })).toBeNull();
  });

  it('says less than a day rather than zero days', async () => {
    mockApi({ list: listOf(request({ kind: 'erasure', status: 'pending', executeAfter: iso(3600_000) })) });
    renderPage();
    expect(await screen.findByText(/کمتر از یک روز دیگر/)).toBeInTheDocument();
  });

  it('cancels by the request id and re-reads the list', async () => {
    let listed = 0;
    mockApi({
      list: () => (++listed === 1 ? ok([request({ id: 'er-1', kind: 'erasure', status: 'pending', executeAfter: iso(3 * DAY) })]) : ok([request({ id: 'er-1', kind: 'erasure', status: 'cancelled' })])),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'لغو درخواست حذف' }));
    await waitFor(() => expect(calls('/v1/privacy/deletion/er-1/cancel', 'POST')).toHaveLength(1));
    expect(await screen.findByText(/درخواست حذف قبلی شما لغو شد/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'شروع حذف حساب' })).toBeInTheDocument();
  });

  it('offers no cancel once the request is running — there is nothing left to cancel', async () => {
    mockApi({ list: listOf(request({ kind: 'erasure', status: 'processing', executeAfter: iso(-3600_000) })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'حذف حساب' });
    expect(within(card).queryByRole('button', { name: 'لغو درخواست حذف' })).toBeNull();
    expect(within(card).getByText(/دیگر قابل لغو نیست/)).toBeInTheDocument();
  });

  it('says a failed deletion left the account as it was, and lets the customer start again', async () => {
    mockApi({ list: listOf(request({ kind: 'erasure', status: 'failed' })) });
    renderPage();
    const card = await screen.findByRole('region', { name: 'حذف حساب' });
    expect(within(card).getByText(/حساب شما بدون تغییر مانده است/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'شروع حذف حساب' })).toBeInTheDocument();
  });

  it('shows the server’s sentence on a refusal, without hiding what is already open', async () => {
    mockApi({ requestErasure: () => fail(409, 'CONFLICT', 'یک درخواست حذف حساب در حال انجام دارید.') });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'شروع حذف حساب' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/عبارت DELETE را تایپ کنید/), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'شروع حذف' }));
    expect(await screen.findByText('یک درخواست حذف حساب در حال انجام دارید.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
