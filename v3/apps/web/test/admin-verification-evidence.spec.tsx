import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminVerificationPage from '@/app/admin/verification/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/verification',
}));

/**
 * `/admin/verification`, against `21_ADMIN_VERIFICATION.md`: the documents a
 * professional attached, opened on demand with the server's short-lived link,
 * and a decision that cannot be sent without a reason the server will accept.
 */

const ok = (data: unknown, meta: unknown = null) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code: 'ERR', message } }) });

const REQUESTS = [
  { id: 'req-1', professionalId: 'prof-abcdef12', status: 'pending', note: 'مدارک آماده است', submittedAt: '2026-09-15T06:30:00.000Z', decidedAt: null, decisionReason: null, displayName: 'سالن نمونه', cityId: null },
  { id: 'req-2', professionalId: 'prof-99887766', status: 'pending', note: null, submittedAt: '2026-09-16T06:30:00.000Z', decidedAt: null, decisionReason: null, displayName: 'آرایشگاه دوم', cityId: null },
];

const DOCS = [
  { id: 'e1', mediaId: 'm1', downloadUrl: 'http://localhost:3099/api/v1/media/m1/download?token=abc', createdAt: '2026-09-15T06:00:00.000Z' },
  { id: 'e2', mediaId: 'm2', downloadUrl: 'http://localhost:3099/api/v1/media/m2/download?token=def', createdAt: '2026-09-15T06:05:00.000Z' },
];

function mockApi(evidence: { [id: string]: () => Promise<unknown> } = {}, decide?: () => Promise<unknown>) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities: ['bc_moderate_verification'] });
    if (url.includes('/v1/admin/verification/queue')) return ok(REQUESTS, { pagination: { page: 1, limit: 20, total: 2 } });
    const doc = url.match(/\/v1\/admin\/verification\/([^/]+)\/evidence/);
    if (doc) return (evidence[doc[1]] ?? (() => ok([])))();
    if (url.includes('/decide')) return decide ? decide() : ok({ ...REQUESTS[0], status: 'approved' });
    return ok([]);
  });
}

function calls(fragment: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
}

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminVerificationPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const card = (id: string) => document.querySelector(`[data-request="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the documents', () => {
  it('asks for none of them until an operator opens one — a queue of twenty is one request', async () => {
    mockApi();
    renderPage();
    await screen.findByText('سالن نمونه');
    expect(calls('/evidence')).toHaveLength(0);
    expect(within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows each document as a link to the server’s short-lived URL, opened in a new tab without the opener', async () => {
    mockApi({ 'req-1': () => ok(DOCS) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('سالن نمونه');
    await user.click(within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' }));

    const first = await within(card('req-1')).findByRole('link', { name: /مشاهدهٔ مدرک ۱/ });
    const second = within(card('req-1')).getByRole('link', { name: /مشاهدهٔ مدرک ۲/ });
    expect(first).toHaveAttribute('href', DOCS[0].downloadUrl);
    expect(second).toHaveAttribute('href', DOCS[1].downloadUrl);
    expect(first).toHaveAttribute('target', '_blank');
    expect(first.getAttribute('rel')).toContain('noopener');
    // The URL is opened, never printed.
    expect(card('req-1').textContent).not.toContain('token=');
    expect(calls('/v1/admin/verification/req-1/evidence')).toHaveLength(1);
    expect(calls('/v1/admin/verification/req-2/evidence')).toHaveLength(0);
  });

  it('says plainly when a request has no documents, rather than showing an empty area', async () => {
    mockApi({ 'req-2': () => ok([]) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('آرایشگاه دوم');
    await user.click(within(card('req-2')).getByRole('button', { name: 'مشاهدهٔ مدارک' }));
    expect(await within(card('req-2')).findByText('برای این درخواست مدرکی بارگذاری نشده است.')).toBeInTheDocument();
  });

  it('reports a failure to load them, offers a retry, and never claims there are none', async () => {
    let attempt = 0;
    mockApi({ 'req-1': () => (++attempt === 1 ? fail(500, 'خطای سرور') : ok(DOCS)) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('سالن نمونه');
    await user.click(within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' }));
    expect(await within(card('req-1')).findByText('خطای سرور')).toBeInTheDocument();
    expect(within(card('req-1')).queryByText('برای این درخواست مدرکی بارگذاری نشده است.')).toBeNull();

    await user.click(within(card('req-1')).getByRole('button', { name: 'تلاش دوباره' }));
    expect(await within(card('req-1')).findByRole('link', { name: /مشاهدهٔ مدرک ۱/ })).toBeInTheDocument();
  });

  it('closes and reopens without asking the server again', async () => {
    mockApi({ 'req-1': () => ok(DOCS) });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('سالن نمونه');
    const toggle = within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' });
    await user.click(toggle);
    await within(card('req-1')).findByRole('link', { name: /مشاهدهٔ مدرک ۱/ });
    await user.click(within(card('req-1')).getByRole('button', { name: 'پنهان کردن مدارک' }));
    expect(within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' })).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(card('req-1')).getByRole('button', { name: 'مشاهدهٔ مدارک' }));
    expect(calls('/v1/admin/verification/req-1/evidence')).toHaveLength(1);
  });
});

describe('the decision', () => {
  it('cannot be sent with a reason the server would refuse, and says why', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByText('سالن نمونه').then(() => card('req-1'))).getByRole('button', { name: 'تأیید' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'تأیید نهایی' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('دلیل تصمیم'), 'ok');
    expect(within(dialog).getByText('دلیل باید حداقل ۴ نویسه باشد.')).toBeInTheDocument();
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('دلیل تصمیم'), 'ay!');
    expect(within(dialog).queryByText('دلیل باید حداقل ۴ نویسه باشد.')).toBeNull();
    expect(confirm).toBeEnabled();
    expect(calls('/decide')).toHaveLength(0);
  });

  it('counts the reason after trimming — four spaces are not a reason', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('سالن نمونه');
    await user.click(within(card('req-1')).getByRole('button', { name: 'رد' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل تصمیم'), '     ');
    expect(within(dialog).getByRole('button', { name: 'رد کن' })).toBeDisabled();
  });

  it('shows the server’s reason when it refuses, and reloads the queue', async () => {
    mockApi({}, () => fail(409, 'این درخواست قبلاً بررسی شده است.'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('سالن نمونه');
    await user.click(within(card('req-1')).getByRole('button', { name: 'تأیید' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل تصمیم'), 'مدارک بررسی شد');
    await user.click(within(dialog).getByRole('button', { name: 'تأیید نهایی' }));

    expect(await screen.findByText('این درخواست قبلاً بررسی شده است.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('/v1/admin/verification/queue').length).toBeGreaterThanOrEqual(2);
  });
});
