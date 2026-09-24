import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BusinessLayout from '@/app/business/layout';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/business',
}));

/**
 * The professional column settles in TWO steps, not one: the profile arrives and
 * draws the column, and only then does `ProProvider` read the upcoming-booking
 * count that fills the «رزروها» badge (#282). A test that asserts as soon as the
 * column exists has not waited for the second, and the state update lands after
 * it finishes — which `test/setup.ts` correctly calls an unexpected console
 * error rather than letting it pass as a warning nobody reads (#298).
 *
 * So the two seller tests here await the badge, not the column. It is the last
 * thing this frame does, and awaiting it is what makes them deterministic rather
 * than dependent on how many microtask ticks their assertions happen to flush.
 */

/**
 * `/business` is advertised in the professional's own column and sheet, and is
 * also opened from the customer header and the footer (#281). Its frame is
 * chosen by the session's identity: a seller gets the professional shell, anyone
 * else gets the page bare inside the customer shell every route already has.
 *
 * The page itself is stood in for by a paragraph — what is asserted here is the
 * frame, and the current-destination marking on both surfaces that draw it.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function mockApi(roles: string[]) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles, capabilities: [] });
    if (url.includes('/v1/me/provider')) {
      return ok({ id: 'prof-1', displayName: 'سارا محمدی', verificationStatus: 'verified' });
    }
    // Answered explicitly rather than falling through to `ok([])`, because the
    // professional column mounts `ProProvider`, which reads this as a SECOND
    // request once the profile is ready (#282). A non-zero count is what makes
    // the badge render, and the badge is what the seller tests below await to
    // know that second read has landed.
    if (url.includes('/professional-bookings/upcoming-count')) return ok({ upcomingCount: 3 });
    return ok([]);
  });
}

function page() {
  return render(
    <AuthProvider>
      <BusinessLayout>
        <p>صفحهٔ کسب‌وکار</p>
      </BusinessLayout>
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('/business in a seller’s session', () => {
  it('renders the professional column around the page, with identity', async () => {
    mockApi(['professional']);
    page();

    expect(await screen.findByRole('navigation', { name: 'ناوبری متخصص' })).toBeInTheDocument();
    expect(await screen.findByTestId('pro-identity')).toHaveTextContent('سارا محمدی');
    await screen.findByTestId('pro-nav-upcoming-count');
    expect(screen.getByText('صفحهٔ کسب‌وکار')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'بازگشت به نمای مشتری' })).toBeInTheDocument();
  });

  it('marks «کسب‌وکار» as the current destination in the column and in the sheet', async () => {
    mockApi(['professional']);
    page();
    const column = await screen.findByRole('navigation', { name: 'ناوبری متخصص' });
    await screen.findByTestId('pro-nav-upcoming-count');

    expect(column.querySelector('[data-pro-nav="/business"]')).toHaveAttribute('aria-current', 'page');
    // Only that one: `/business` must not read as current for its neighbours.
    expect(column.querySelectorAll('[aria-current="page"]')).toHaveLength(1);

    fireEvent.click(within(screen.getByTestId('mobile-tab-bar')).getByRole('button', { name: 'منو' }));
    const sheet = screen.getByTestId('pro-nav-sheet');
    expect(sheet.querySelector('[data-sheet-nav="/business"]')).toHaveAttribute('aria-current', 'page');
    expect(sheet.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});

describe('/business for everyone else', () => {
  it('leaves a customer’s page bare — no professional column, no sheet', async () => {
    mockApi([]);
    page();

    expect(await screen.findByText('صفحهٔ کسب‌وکار')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/me'), expect.anything()));
    expect(screen.queryByRole('navigation', { name: 'ناوبری متخصص' })).toBeNull();
    expect(screen.queryByTestId('mobile-tab-bar')).toBeNull();
  });

  it('never fetches a professional profile for a session that is not a seller', async () => {
    mockApi(['business_owner']);
    page();
    await screen.findByText('صفحهٔ کسب‌وکار');

    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/v1/me/provider'))).toBe(false);
  });
});

describe('before the session has answered', () => {
  it('shows no column before any session exists — the page alone (the status guard itself is pinned in seller-frame.spec.tsx)', () => {
    // A request that never answers leaves the session in `loading`.
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
    page();

    expect(screen.getByText('صفحهٔ کسب‌وکار')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'ناوبری متخصص' })).toBeNull();
  });
});
