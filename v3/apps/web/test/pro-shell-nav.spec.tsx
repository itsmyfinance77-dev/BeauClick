import { render, screen, waitFor, within } from '@testing-library/react';
import { ProShell } from '@/components/pro-shell';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

let pathname = '/pro';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => pathname,
}));

/**
 * The professional's shell — `Prototype - Pro and Admin.dc.html` §01 and
 * `V3_INFORMATION_ARCHITECTURE.md` §3.
 *
 * The context band was the right idea in the wrong shape: it carried eight
 * destinations in a row that does not hold eight, and broke on a phone. The
 * architecture calls for a fixed column, where all of them are visible and
 * there is room for a counter.
 *
 * What the column MUST keep from the band is the reason the band existed:
 * this is a different mode, operated as somebody specific, with a way back
 * out. Losing any of those while changing the shape would be a regression
 * dressed as a redesign, so each is asserted here.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function mockApi(options: { verificationStatus?: string; hasProfile?: boolean; upcomingCount?: number | 'fails' } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['professional'], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) {
      if (options.hasProfile === false) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ data: null, meta: null, error: { code: 'NOT_FOUND', message: 'no profile' } }),
        });
      }
      return ok({
        id: 'prof-1',
        displayName: 'سارا محمدی',
        verificationStatus: options.verificationStatus ?? 'verified',
      });
    }
    // #282. Declared before nothing that could shadow it, and only answered
    // when a count was asked for -- the default is no route at all, so the
    // existing cases keep exercising a shell with no badge.
    if (url.includes('/v1/me/professional-bookings/upcoming-count')) {
      if (options.upcomingCount === undefined || options.upcomingCount === 'fails') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }),
        });
      }
      return ok({ upcomingCount: options.upcomingCount });
    }
    return ok([]);
  });
}

function renderShell() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProShell>
          <p>محتوا</p>
        </ProShell>
      </ProProvider>
    </AuthProvider>,
  );
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'ناوبری متخصص' });
}

beforeEach(() => {
  pathname = '/pro';
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the professional column', () => {
  it('carries every destination, in the design’s order', async () => {
    mockApi();
    renderShell();
    await screen.findByTestId('pro-identity');

    const hrefs = [...nav().querySelectorAll('[data-pro-nav]')].map((a) => a.getAttribute('data-pro-nav'));
    expect(hrefs).toEqual([
      '/pro',
      '/pro/bookings',
      '/pro/availability',
      '/pro/services',
      '/pro/finance',
      '/pro/analytics',
      '/pro/outcome-policy',
      '/pro/profile',
      '/business',
    ]);
  });

  it('calls the first destination «امروز», which is what it is', async () => {
    mockApi();
    renderShell();
    await screen.findByTestId('pro-identity');

    // The architecture renames it: the page is today's work, and «نمای کلی»
    // described a summary it is not.
    expect(within(nav()).getByRole('link', { name: 'امروز' })).toHaveAttribute('href', '/pro');
    expect(within(nav()).queryByText('نمای کلی')).toBeNull();
  });

  it('marks the current destination without matching every subtree from the root', async () => {
    pathname = '/pro/bookings';
    mockApi();
    renderShell();
    await screen.findByTestId('pro-identity');

    expect(nav().querySelector('[data-pro-nav="/pro/bookings"]')).toHaveAttribute('aria-current', 'page');
    // `/pro` is a prefix of every professional path; it must match itself only.
    expect(nav().querySelector('[data-pro-nav="/pro"]')).not.toHaveAttribute('aria-current');
  });

  it('keeps what the context band existed for: who, what status, and the way out', async () => {
    mockApi({ verificationStatus: 'pending' });
    renderShell();

    const identity = await screen.findByTestId('pro-identity');
    expect(identity.textContent).toContain('سارا محمدی');
    // The real status, not a flattering one — and as text, not a colour.
    expect(identity.textContent).toContain('در انتظار بررسی');
    expect(screen.getByRole('link', { name: /بازگشت به نمای مشتری/ })).toHaveAttribute('href', '/');
  });

  it('shows navigation even before the profile resolves, so the mode is never a dead end', async () => {
    mockApi({ hasProfile: false });
    renderShell();

    // A professional with no profile yet still needs to reach `/pro` to
    // create one; hiding the column would strand them.
    await waitFor(() => expect(nav().querySelectorAll('[data-pro-nav]').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('pro-identity')).toBeNull();
  });

  it('renders the page’s own content beside the column', async () => {
    mockApi();
    renderShell();
    await screen.findByTestId('pro-identity');
    expect(screen.getByText('محتوا')).toBeInTheDocument();
  });
});

/**
 * The upcoming-bookings counter — #282, IA §3's «+ شمارندهٔ پیش‌رو», which is
 * the reason §3 gives for a column at all: «جای شمارنده هم هست».
 */
describe('the upcoming-bookings count', () => {
  const badge = () => screen.queryByTestId('pro-nav-upcoming-count');

  it('sits inside the «رزروها» link, so the number is read with its destination', async () => {
    mockApi({ upcomingCount: 3 });
    renderShell();

    await waitFor(() => expect(badge()).not.toBeNull());
    const link = within(nav()).getByRole('link', { name: /رزروها/ });
    expect(link).toContainElement(badge());
    expect(link).toHaveAttribute('href', '/pro/bookings');
    // Persian digits, plus a hidden half saying what the figure counts — «۳»
    // on its own names nothing.
    expect(badge()).toHaveTextContent('۳');
    expect(link).toHaveAccessibleName('رزروها ۳ رزرو پیش‌رو');
  });

  it('is on «رزروها» and on no other destination', async () => {
    mockApi({ upcomingCount: 3 });
    renderShell();

    await waitFor(() => expect(badge()).not.toBeNull());
    // The nav model names which count sits where, and exactly one destination
    // claims one.
    expect(screen.getAllByTestId('pro-nav-upcoming-count')).toHaveLength(1);
  });

  it('draws nothing when the count is zero, because «۰» beside a destination is noise', async () => {
    mockApi({ upcomingCount: 0 });
    renderShell();

    await screen.findByTestId('pro-identity');
    await waitFor(() => expect(within(nav()).getByRole('link', { name: 'رزروها' })).toBeInTheDocument());
    expect(badge()).toBeNull();
  });

  it('draws nothing when the count could not be read, rather than a zero nobody reported', async () => {
    mockApi({ upcomingCount: 'fails' });
    renderShell();

    await screen.findByTestId('pro-identity');
    expect(badge()).toBeNull();
    // The failure is confined to the badge; the column still works.
    expect(within(nav()).getByRole('link', { name: 'رزروها' })).toHaveAttribute('href', '/pro/bookings');
    expect(screen.getByText('محتوا')).toBeInTheDocument();
  });

  it('asks for no count at all when the user has no professional profile', async () => {
    // The route 404s for them, and a zero would tell someone with no
    // professional identity that they have no upcoming bookings.
    mockApi({ hasProfile: false, upcomingCount: 5 });
    renderShell();

    await waitFor(() => expect(nav().querySelectorAll('[data-pro-nav]').length).toBeGreaterThan(0));
    const asked = (global.fetch as jest.Mock).mock.calls.filter((call) => String(call[0]).includes('/upcoming-count'));
    expect(asked).toEqual([]);
    expect(badge()).toBeNull();
  });
});
