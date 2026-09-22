import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminOverviewPage from '@/app/admin/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin',
}));

/**
 * `/admin`, against `20_ADMIN_OVERVIEW.md`: the queues (work waiting) and the
 * platform figures (information) are two sections under two headings, a queue
 * is a row with its counter and a link to its destination, and a source that
 * failed never reads as zero.
 */

const ok = (data: unknown, meta: unknown = null) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = () => Promise.reject(new TypeError('Failed to fetch'));

const METRICS = {
  bookings: { created: { value: 120 }, completed: { value: 96 } },
  commerce: { grossToman: { value: 84000000 } },
  search: { emptyResultRate: { value: 0.125 } },
};

interface Sources {
  verification?: () => Promise<unknown>;
  conflicts?: () => Promise<unknown>;
  notifications?: () => Promise<unknown>;
  search?: () => Promise<unknown>;
  metrics?: () => Promise<unknown>;
}

function mockApi(capabilities: string[], sources: Sources = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities });
    if (url.includes('/v1/admin/verification/queue')) return sources.verification ? sources.verification() : ok([], { pagination: { page: 1, limit: 1, total: 3 } });
    if (url.includes('/v1/admin/phone-conflicts')) return sources.conflicts ? sources.conflicts() : ok([], { pagination: { page: 1, limit: 25, total: 0 } });
    if (url.includes('/v1/admin/notifications/status')) return sources.notifications ? sources.notifications() : ok({ deadLetters: { total: 2 } });
    if (url.includes('/v1/admin/search/status')) return sources.search ? sources.search() : ok({ physicalIndex: 'i', pendingDocuments: 0, stalePendingOverFiveMinutes: 0 });
    if (url.includes('/v1/admin/analytics')) return sources.metrics ? sources.metrics() : ok(METRICS);
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
        <AdminOverviewPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

/** The moderator's queue only exists once the user is known, so its counter arriving means the page has settled. */
const loaded = () => waitFor(() => expect(queue('/admin/verification')).toHaveTextContent('۳'));

const queue = (href: string) => document.querySelector(`[data-queue="${href}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the two sections', () => {
  it('puts the queues under their own heading, before the platform figures under theirs', async () => {
    mockApi(['bc_moderate_verification']);
    renderPage();
    const queues = await screen.findByRole('heading', { name: 'در انتظار بررسی شما' });
    const figures = screen.getByRole('heading', { name: 'پلتفرم در ۳۰ روز گذشته' });
    expect(queues.compareDocumentPosition(figures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The figures are not inside the queue list, and the queues are not in the figure grid.
    expect(within(queues.closest('section') as HTMLElement).queryByText('رزروهای ثبت‌شده')).toBeNull();
    expect(within(figures.closest('section') as HTMLElement).queryByText('درخواست احراز هویت')).toBeNull();
  });

  it('shows the platform figures', async () => {
    mockApi(['bc_moderate_verification']);
    renderPage();
    expect(await screen.findByText('رزروهای ثبت‌شده')).toBeInTheDocument();
    expect(screen.getByText('نوبت‌های انجام‌شده')).toBeInTheDocument();
    expect(screen.getByText('۱۳٪')).toBeInTheDocument();
  });
});

describe('a queue', () => {
  it('is a row with its counter, its state, and a link to its own destination', async () => {
    mockApi(['bc_moderate_verification']);
    renderPage();
    await loaded();
    const verification = queue('/admin/verification');
    expect(verification).toHaveTextContent('۳');
    expect(within(verification).getByText('نیازمند بررسی')).toBeInTheDocument();
    expect(within(verification).getByRole('link', { name: 'مشاهدهٔ درخواست احراز هویت' })).toHaveAttribute('href', '/admin/verification');

    const conflicts = queue('/admin/phone-conflicts');
    expect(conflicts).toHaveTextContent('۰');
    expect(within(conflicts).getByText('بدون مورد')).toBeInTheDocument();
    expect(within(conflicts).getByRole('link', { name: 'مشاهدهٔ تعارض شماره بررسی‌نشده' })).toHaveAttribute('href', '/admin/phone-conflicts');
  });

  it('gives every link its own name — four bare «مشاهده» are not a list of destinations', async () => {
    mockApi(['bc_moderate_verification']);
    renderPage();
    await loaded();
    const names = screen.getAllByRole('link', { name: /^مشاهدهٔ / }).map((a) => a.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(4);
  });

  it('never reads a source that failed as zero', async () => {
    mockApi(['bc_moderate_verification'], { conflicts: fail, search: fail });
    renderPage();
    await loaded();
    const conflicts = queue('/admin/phone-conflicts');
    expect(within(conflicts).getByText('خوانده نشد')).toBeInTheDocument();
    expect(conflicts).toHaveTextContent('—');
    expect(conflicts).not.toHaveTextContent('۰');
    expect(within(conflicts).queryByText('بدون مورد')).toBeNull();
    // The queues that did load still show.
    expect(queue('/admin/verification')).toHaveTextContent('۳');
  });

  it('leaves the verification queue out, and never asks for it, without the moderation capability', async () => {
    mockApi(['bc_manage_platform']);
    renderPage();
    await screen.findByText('تعارض شماره بررسی‌نشده');
    expect(queue('/admin/verification')).toBeNull();
    expect(calls('/v1/admin/verification/queue')).toHaveLength(0);
  });
});

describe('the platform figures', () => {
  it('say so, with a retry, when they fail — the heading does not stand over nothing', async () => {
    // A switch, not a count of requests: the page loads once before it knows the
    // operator's capabilities and again after, so "the first request fails" is
    // a race between those two loads and the test passed or failed with the load.
    let failing = true;
    mockApi(['bc_moderate_verification'], { metrics: () => (failing ? fail() : ok(METRICS)) });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('آمار پلتفرم بارگذاری نشد.')).toBeInTheDocument();
    await loaded(); // both loads are over, so the number of requests below is fixed
    expect(screen.getByText('آمار پلتفرم بارگذاری نشد.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'پلتفرم در ۳۰ روز گذشته' })).toBeInTheDocument();

    const before = calls('/v1/admin/analytics').length;
    failing = false;
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByText('رزروهای ثبت‌شده')).toBeInTheDocument();
    expect(screen.queryByText('آمار پلتفرم بارگذاری نشد.')).toBeNull();
    expect(calls('/v1/admin/analytics')).toHaveLength(before + 1);
  });
});
