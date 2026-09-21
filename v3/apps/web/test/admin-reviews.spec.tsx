import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminReviewsPage from '@/app/admin/reviews/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/reviews',
}));

/**
 * `/admin/reviews`, against `28_ADMIN_REVIEW_MODERATION.md`: two decisions of
 * equal weight, a mandatory reason either way, no irreversible-deletion
 * language (hiding a review is reversible), and nothing touching loyalty.
 */

const ok = (data: unknown, meta: unknown = null) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const REVIEWS = [
  { id: 'rv-1', professionalId: 'prof-1', displayName: 'سالن نگین', rating: 1, comment: 'برخورد بسیار بدی داشتند', status: 'published', createdAt: '2026-09-15T06:30:00.000Z' },
  { id: 'rv-2', professionalId: 'prof-2', displayName: 'آرایشگاه ستاره', rating: 5, comment: null, status: 'published', createdAt: '2026-09-16T06:30:00.000Z' },
];

function mockApi({
  capabilities = ['bc_moderate_reviews'],
  queue = () => ok(REVIEWS, { pagination: { page: 1, limit: 20, total: REVIEWS.length } }),
  moderate = () => ok({ id: 'rv-1', status: 'hidden', moderatedAt: null }),
}: {
  capabilities?: string[];
  queue?: () => Promise<unknown>;
  moderate?: () => Promise<unknown>;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'ناظر', roles: [], capabilities });
    if (url.includes('/moderate')) return moderate();
    if (url.includes('/v1/admin/reviews/queue')) return queue();
    return ok([]);
  });
}

const calls = (fragment: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
const bodies = () => calls('/moderate').map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminReviewsPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-review="${id}"]`) as HTMLElement;

async function openReview(user: ReturnType<typeof userEvent.setup>, id: string) {
  await screen.findByRole('table');
  await user.click(within(row(id)).getByRole('button', { name: /^بررسی دیدگاه/ }));
  return document.querySelector('[data-panel]') as HTMLElement;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a platform operator without `bc_moderate_reviews` — content moderation is not platform operation', async () => {
    mockApi({ capabilities: ['bc_manage_platform', 'bc_moderate_verification'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(calls('/v1/admin/reviews/queue')).toHaveLength(0);
  });
});

describe('the queue', () => {
  it('lists each review with the professional, the stars read out as words, and the text', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('rv-1')).getByText('سالن نگین')).toBeInTheDocument();
    expect(within(row('rv-1')).getByLabelText('۱ ستاره از ۵')).toBeInTheDocument();
    expect(within(row('rv-1')).getByText('برخورد بسیار بدی داشتند')).toBeInTheDocument();
    expect(within(row('rv-2')).getByText('بدون متن')).toBeInTheDocument();
  });

  it('says so when the queue is empty', async () => {
    mockApi({ queue: () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }) });
    renderPage();
    expect(await screen.findByText('صف بازبینی خالی است.')).toBeInTheDocument();
  });
});

describe('the decision', () => {
  it('offers «انتشار» and «حذف» at equal weight: same look, neither focused first, enabled together', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const panel = await openReview(user, 'rv-1');

    const group = within(panel).getByRole('group', { name: 'تصمیم' });
    const [first, second] = within(group).getAllByRole('button');
    expect(first).toHaveTextContent('انتشار');
    expect(second).toHaveTextContent('حذف');
    expect(first.getAttribute('style')).toBe(second.getAttribute('style'));
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveFocus();

    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    await user.type(within(panel).getByLabelText('دلیل تصمیم'), 'abcd');
    expect(first).toBeEnabled();
    expect(second).toBeEnabled();
    expect(first.getAttribute('style')).toBe(second.getAttribute('style'));
  });

  it('does not borrow the media queue’s irreversible language — hiding a review can be undone', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const panel = await openReview(user, 'rv-1');
    expect(panel.textContent).not.toContain('غیرقابل‌بازگشت');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['حذف', 'hide'],
    ['انتشار', 'publish'],
  ])('sends «%s» with the trimmed reason, reloads, and moves focus to the next review', async (label, decision) => {
    let done = false;
    mockApi({
      queue: () => ok(done ? REVIEWS.slice(1) : REVIEWS, { pagination: { page: 1, limit: 20, total: 2 } }),
      moderate: () => {
        done = true;
        return ok({ id: 'rv-1', status: decision === 'hide' ? 'hidden' : 'published', moderatedAt: null });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const panel = await openReview(user, 'rv-1');
    await user.type(within(panel).getByLabelText('دلیل تصمیم'), '  توهین‌آمیز نیست  ');
    await user.click(within(panel).getByRole('button', { name: label }));

    await waitFor(() => expect(row('rv-1')).toBeNull());
    expect(bodies()).toEqual([{ decision, reason: 'توهین‌آمیز نیست' }]);
    expect(calls('/v1/admin/reviews/rv-1/moderate')).toHaveLength(1);
    await waitFor(() => expect(within(row('rv-2')).getByRole('button')).toHaveFocus());
  });

  it('keeps «already moderated» on screen after the reload that follows it', async () => {
    mockApi({ moderate: () => fail(409, 'CONFLICT', 'این دیدگاه پیش‌تر بررسی شده است.') });
    const user = userEvent.setup();
    renderPage();
    const panel = await openReview(user, 'rv-1');
    await user.type(within(panel).getByLabelText('دلیل تصمیم'), 'دلیل کافی');
    await user.click(within(panel).getByRole('button', { name: 'حذف' }));

    expect(await screen.findByText('این دیدگاه پیش‌تر بازبینی شده است. صف تازه شد.')).toBeInTheDocument();
    expect(calls('/v1/admin/reviews/queue')).toHaveLength(2);
  });

  it('touches nothing in loyalty — points on a removed review are an open product question (spec 28)', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const panel = await openReview(user, 'rv-1');
    await user.type(within(panel).getByLabelText('دلیل تصمیم'), 'دلیل کافی');
    await user.click(within(panel).getByRole('button', { name: 'حذف' }));
    await waitFor(() => expect(calls('/moderate')).toHaveLength(1));
    expect(calls('loyalty')).toHaveLength(0);
  });
});
