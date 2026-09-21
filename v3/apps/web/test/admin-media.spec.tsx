import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminMediaPage from '@/app/admin/media/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';
import { UNKNOWN_REASON_LABEL } from '@/lib/moderation-labels';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/media',
}));

/**
 * `/admin/media`, against `27_ADMIN_MEDIA_MODERATION.md` — with one deliberate
 * departure, #265: the report carries no way to show the image, so the
 * irreversible «تأیید و حذف» is not offered and no uphold can be sent.
 */

const ok = (data: unknown, meta: unknown = null) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const REPORTS = [
  { id: 'rep-1', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0001', reason: 'explicit', note: 'این تصویر مناسب نمایه نیست', status: 'open', createdAt: '2026-09-15T06:30:00.000Z' },
  { id: 'rep-2', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0002', reason: 'not_own_work', note: null, status: 'open', createdAt: '2026-09-16T06:30:00.000Z' },
  { id: 'rep-3', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0003', reason: 'brand_new_reason', note: null, status: 'open', createdAt: '2026-09-17T06:30:00.000Z' },
];

function mockApi({
  capabilities = ['bc_manage_platform', 'bc_moderate_media'],
  queue = () => ok(REPORTS, { pagination: { page: 1, limit: 20, total: REPORTS.length } }),
  decide = () => ok({ id: 'rep-1', status: 'rejected', decidedAt: '2026-09-18T00:00:00.000Z' }),
}: {
  capabilities?: string[];
  queue?: () => Promise<unknown>;
  decide?: () => Promise<unknown>;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'ناظر', roles: [], capabilities });
    if (url.includes('/decide')) return decide();
    if (url.includes('/v1/admin/media/reports')) return queue();
    return ok([]);
  });
}

const calls = (fragment: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
const decideBodies = () => calls('/decide').map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminMediaPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-report="${id}"]`) as HTMLElement;
const panel = () => document.querySelector('[data-panel]') as HTMLElement | null;

async function openReport(user: ReturnType<typeof userEvent.setup>, id: string) {
  await screen.findByRole('table');
  await user.click(within(row(id)).getByRole('button', { name: /^بررسی گزارش/ }));
  return panel() as HTMLElement;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a platform operator without `bc_moderate_media`, and never asks for the queue', async () => {
    mockApi({ capabilities: ['bc_manage_platform', 'bc_moderate_verification'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(calls('/v1/admin/media/reports')).toHaveLength(0);
  });
});

describe('the queue', () => {
  it('lists each report with its reason in Persian and a neutral word for a reason it has never heard of', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('rep-1')).getByText('محتوای نامناسب')).toBeInTheDocument();
    expect(within(row('rep-2')).getByText('اثرِ شخص دیگری است')).toBeInTheDocument();
    expect(within(row('rep-3')).getByText(UNKNOWN_REASON_LABEL)).toBeInTheDocument();
    expect(row('rep-3').textContent).not.toContain('brand_new_reason');
  });

  it('shows no image anywhere — the API gives it nothing to show (#265)', async () => {
    mockApi();
    const user = userEvent.setup();
    const { container } = renderPage();
    await openReport(user, 'rep-1');
    expect(container.querySelector('img')).toBeNull();
    expect(within(panel() as HTMLElement).getByRole('note')).toHaveTextContent('پیش‌نمایش این تصویر هنوز از سرور در دسترس نیست');
  });

  it('says so when there is nothing to review', async () => {
    mockApi({ queue: () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }) });
    renderPage();
    expect(await screen.findByText('هیچ گزارشِ بازی وجود ندارد.')).toBeInTheDocument();
  });

  it('does not call a failed load an empty queue, and offers a retry', async () => {
    mockApi({ queue: () => fail(500, 'INTERNAL', 'خطای سرور') });
    renderPage();
    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    expect(screen.queryByText('هیچ گزارشِ بازی وجود ندارد.')).toBeNull();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});

describe('the decision', () => {
  it('opens the panel on demand with the full note, and moves focus into it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    expect(within(opened).getByText('این تصویر مناسب نمایه نیست')).toBeInTheDocument();
    expect(within(opened).getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('never offers the irreversible deletion on an image nobody can see, and never sends one', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'تصویر نامناسب است');

    const uphold = within(opened).getByRole('button', { name: 'تأیید و حذف' });
    expect(uphold).toBeDisabled();
    // The reason is on the button itself, not only in nearby prose.
    const describedBy = uphold.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)).toHaveTextContent('غیرقابل‌بازگشت');

    await user.click(uphold);
    expect(decideBodies().filter((body) => body.decision === 'uphold')).toEqual([]);
  });

  it('waits for a reason the server will accept before a rejection can be sent', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    const reject = within(opened).getByRole('button', { name: 'رد گزارش' });
    expect(reject).toBeDisabled();

    await user.type(within(opened).getByLabelText('دلیل تصمیم'), '  ab  ');
    expect(reject).toBeDisabled();
    expect(within(opened).getByText('دلیل باید حداقل ۴ نویسه باشد.')).toBeInTheDocument();

    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'cd');
    expect(reject).toBeEnabled();
  });

  it('sends the rejection with the trimmed reason, reloads the queue, and puts focus on the next report', async () => {
    let decided = false;
    mockApi({
      queue: () => ok(decided ? REPORTS.slice(1) : REPORTS, { pagination: { page: 1, limit: 20, total: 3 } }),
      decide: () => {
        decided = true;
        return ok({ id: 'rep-1', status: 'rejected', decidedAt: null });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), '  تصویر از خودِ متخصص است  ');
    await user.click(within(opened).getByRole('button', { name: 'رد گزارش' }));

    await waitFor(() => expect(row('rep-1')).toBeNull());
    expect(decideBodies()).toEqual([{ decision: 'reject', reason: 'تصویر از خودِ متخصص است' }]);
    expect(calls('/v1/admin/media/reports/rep-1/decide')).toHaveLength(1);
    await waitFor(() => expect(within(row('rep-2')).getByRole('button')).toHaveFocus());
  });

  it('keeps a colleague’s earlier decision on screen AFTER reloading, rather than letting the reload erase it', async () => {
    mockApi({ decide: () => fail(400, 'CONFLICT', 'این گزارش پیش‌تر بررسی شده است.') });
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'دلیل کافی');
    await user.click(within(opened).getByRole('button', { name: 'رد گزارش' }));

    expect(await screen.findByText('این گزارش پیش‌تر توسط اپراتور دیگری بررسی شده است. صف تازه شد.')).toBeInTheDocument();
    // Queue fetched twice: the first load and the reload after the refusal.
    expect(calls('/v1/admin/media/reports?')).toHaveLength(2);
  });
});
