import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WishlistPage from '@/app/wishlist/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/wishlist',
}));

/**
 * `/wishlist`, against `38_WISHLIST.md`. A saved item is a target and a date
 * and nothing else, so what is asserted here is what the page may and may not
 * claim about one: a name only where the public profile gave one, a neutral
 * tombstone for anything unavailable, and no count of anything.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const noContent = () => Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
const fail = (status: number, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code: 'ERR', message } }) });

const item = (over: Record<string, unknown>) => ({
  targetType: 'professional',
  targetId: 'prof-1',
  savedAt: '2026-09-10T08:00:00.000Z',
  state: 'available',
  ...over,
});

interface Routes {
  pages?: Array<() => Promise<unknown>>;
  provider?: (id: string) => Promise<unknown>;
  remove?: () => Promise<unknown>;
}

function mockApi(routes: Routes = {}) {
  let page = 0;
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: [] });
    if (url.includes('/v1/me/wishlist/items') && method === 'GET') {
      const handler = routes.pages?.[page++] ?? (() => ok({ items: [], nextCursor: null }));
      return handler();
    }
    if (url.includes('/v1/me/wishlist/items') && method === 'DELETE') return routes.remove ? routes.remove() : noContent();
    const provider = url.match(/\/v1\/providers\/([^/?]+)$/);
    if (provider) {
      return routes.provider ? routes.provider(provider[1]) : ok({ id: provider[1], displayName: `آتلیه ${provider[1]}` });
    }
    return ok([]);
  });
}

const pageOf = (items: unknown[], nextCursor: string | null = null) => () => ok({ items, nextCursor });

function calls(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]: [string, RequestInit | undefined]) => String(url).includes(fragment) && (!method || (init?.method ?? 'GET').toUpperCase() === method),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <WishlistPage />
    </AuthProvider>,
  );
}

const row = (key: string) => document.querySelector(`[data-target="${key}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the list', () => {
  it('names an available professional from their public profile and links to it', async () => {
    mockApi({ pages: [pageOf([item({})])] });
    renderPage();
    const link = await screen.findByRole('link', { name: 'آتلیه prof-1' });
    expect(link).toHaveAttribute('href', '/providers/prof-1');
    expect(within(row('professional:prof-1')).getByText(/ذخیره‌شده در/)).toBeInTheDocument();
  });

  it('still shows a professional whose name could not be read — linked, removable, nothing invented', async () => {
    mockApi({ pages: [pageOf([item({})])], provider: () => fail(500, 'x') });
    renderPage();
    const link = await screen.findByRole('link', { name: 'متخصص ذخیره‌شده' });
    expect(link).toHaveAttribute('href', '/providers/prof-1');
    expect(within(row('professional:prof-1')).getByRole('button', { name: /حذف/ })).toBeInTheDocument();
  });

  it('shows a saved service as a saved service — there is no route that names its professional', async () => {
    mockApi({ pages: [pageOf([item({ targetType: 'service', targetId: 'svc-1' })])] });
    renderPage();
    const service = await waitFor(() => {
      const el = row('service:svc-1');
      expect(el).not.toBeNull();
      return el;
    });
    expect(within(service).getByText('خدمت ذخیره‌شده')).toBeInTheDocument();
    expect(within(service).queryByRole('link')).toBeNull();
    // Nothing was asked of the professional route for it.
    expect(calls('/v1/providers/')).toHaveLength(0);
  });

  it('shows one neutral tombstone for anything unavailable: no name, no cause, no lookup, remove only', async () => {
    mockApi({ pages: [pageOf([item({ state: 'unavailable' }), item({ targetType: 'service', targetId: 'svc-9', state: 'unavailable' })])] });
    renderPage();
    await screen.findAllByText('این مورد دیگر در دسترس نیست.');
    for (const key of ['professional:prof-1', 'service:svc-9']) {
      const gone = row(key);
      expect(within(gone).getByText('این مورد دیگر در دسترس نیست.')).toBeInTheDocument();
      expect(within(gone).queryByRole('link')).toBeNull();
      expect(within(gone).getByRole('button', { name: 'حذف این مورد از علاقه‌مندی‌ها' })).toBeInTheDocument();
    }
    expect(calls('/v1/providers/')).toHaveLength(0);
  });

  it('counts nothing: no total, no “N people saved this”', async () => {
    mockApi({ pages: [pageOf([item({}), item({ targetId: 'prof-2' })])] });
    renderPage();
    await screen.findByRole('link', { name: 'آتلیه prof-1' });
    expect(document.body.textContent).not.toMatch(/[۰-۹0-9]+\s*(مورد|نفر|علاقه)/);
  });
});

describe('the states', () => {
  it('says the list is empty and points to search', async () => {
    mockApi({ pages: [pageOf([])] });
    renderPage();
    expect(await screen.findByText('فهرست علاقه‌مندی‌های شما خالی است.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'جست‌وجوی متخصص' })).toHaveAttribute('href', '/search');
  });

  it('offers a retry when the list fails to load, and never claims it is empty', async () => {
    mockApi({ pages: [() => fail(500, 'خطای سرور'), pageOf([item({})])] });
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(screen.queryByText('فهرست علاقه‌مندی‌های شما خالی است.')).toBeNull();
    await user.click(retry);
    expect(await screen.findByRole('link', { name: 'آتلیه prof-1' })).toBeInTheDocument();
  });
});

describe('paging', () => {
  it('reads the next page with the opaque cursor, appends it, and shows each target once', async () => {
    mockApi({
      pages: [
        pageOf([item({ targetId: 'prof-1' })], 'CURSOR-1'),
        pageOf([item({ targetId: 'prof-1' }), item({ targetId: 'prof-2' })], null),
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'آتلیه prof-1' });
    await user.click(screen.getByRole('button', { name: 'بیشتر' }));
    expect(await screen.findByRole('link', { name: 'آتلیه prof-2' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'آتلیه prof-1' })).toHaveLength(1);
    expect(calls('/v1/me/wishlist/items', 'GET')[1][0]).toContain('cursor=CURSOR-1');
    expect(screen.queryByRole('button', { name: 'بیشتر' })).toBeNull();
  });

  it('keeps page one intact when page two fails, and offers a retry on the button alone', async () => {
    mockApi({ pages: [pageOf([item({})], 'CURSOR-1'), () => fail(500, 'صفحهٔ بعد بارگذاری نشد.'), pageOf([item({ targetId: 'prof-2' })])] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'آتلیه prof-1' });
    await user.click(screen.getByRole('button', { name: 'بیشتر' }));
    expect(await screen.findByText('صفحهٔ بعد بارگذاری نشد.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'آتلیه prof-1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByRole('link', { name: 'آتلیه prof-2' })).toBeInTheDocument();
  });
});

describe('removing', () => {
  it('removes by the natural key and drops the row', async () => {
    mockApi({ pages: [pageOf([item({}), item({ targetId: 'prof-2' })])] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'آتلیه prof-1' });
    await user.click(screen.getByRole('button', { name: 'حذف آتلیه prof-1 از علاقه‌مندی‌ها' }));
    await waitFor(() => expect(row('professional:prof-1')).toBeNull());
    expect(calls('/v1/me/wishlist/items/professional/prof-1', 'DELETE')).toHaveLength(1);
    expect(row('professional:prof-2')).not.toBeNull();
  });

  it('keeps the row and says so when the removal fails', async () => {
    mockApi({ pages: [pageOf([item({})])], remove: () => fail(500, 'حذف انجام نشد.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'آتلیه prof-1' });
    await user.click(screen.getByRole('button', { name: /حذف/ }));
    expect(await screen.findByText('حذف انجام نشد.')).toBeInTheDocument();
    expect(row('professional:prof-1')).not.toBeNull();
  });

  it('lets an unavailable item be removed', async () => {
    mockApi({ pages: [pageOf([item({ state: 'unavailable' })])] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'حذف این مورد از علاقه‌مندی‌ها' }));
    await waitFor(() => expect(row('professional:prof-1')).toBeNull());
  });
});
