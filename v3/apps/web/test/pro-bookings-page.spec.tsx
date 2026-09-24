import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProBookingsPage from '@/app/pro/bookings/page';
import { ProShell } from '@/components/pro-shell';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/bookings',
}));

/**
 * What the redesigned bookings page adds, against `05_PRO_BOOKINGS.md`: a real
 * tablist with a separate cancelled tab, a heading per platform-local day, and
 * a confirm dialog whose consequence text is its accessible description. The
 * page's behaviour (state discipline, pagination, the reasons an action is
 * absent) is covered by `pro-surface.spec.tsx` and is unchanged.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

const PROFILE = {
  id: 'prof-1',
  displayName: 'سالن آزمایشی',
  bio: null,
  cityId: null,
  specialties: [],
  verificationStatus: 'verified',
  createdAt: new Date().toISOString(),
};

/** A booking `hours` from now (negative = past) lasting an hour. */
function booking(id: string, status: string, hours: number) {
  return {
    id,
    customerId: 'cust-abcdef12',
    customerDisplayName: 'مریم احمدی',
    professionalId: 'prof-1',
    serviceId: null,
    slotId: `slot-${id}`,
    startAt: new Date(Date.now() + hours * HOUR).toISOString(),
    endAt: new Date(Date.now() + (hours + 1) * HOUR).toISOString(),
    status,
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The rule the SERVER counts by (#282): an open status, `endAt` still ahead.
 * Restated here so the fixture's default count is the one a real server would
 * give for the same rows, rather than a number chosen to make a test pass.
 */
const serverUpcomingCount = (list: unknown[]) =>
  (list as { status: string; endAt: string }[]).filter(
    (b) => !['completed', 'cancelled', 'expired', 'no_show'].includes(b.status) && new Date(b.endAt).getTime() > Date.now(),
  ).length;

function mockApi(
  list: unknown[],
  extra: Record<string, () => Promise<unknown>> = {},
  /** Overridable so a test can prove the label follows the SERVER and not the rows it holds. */
  upcomingCount: number | 'fails' = serverUpcomingCount(list),
) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/v1/me/provider')) return ok(PROFILE);
    // Ordered most-specific first: the list fragment is a prefix of this one.
    if (url.includes('/v1/me/professional-bookings/upcoming-count')) {
      return upcomingCount === 'fails'
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }) })
        : ok({ upcomingCount });
    }
    if (url.includes('/v1/me/professional-bookings')) return ok(list);
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProBookingsPage />
      </ProProvider>
    </AuthProvider>,
  );
}

/**
 * The page inside its real shell, under ONE `ProProvider` — #282.
 *
 * The badge and the tab label are two surfaces reading one number, and the only
 * way to assert they cannot disagree is to render both together and give them a
 * count that contradicts the rows.
 */
function renderWithShell() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProShell>
          <ProBookingsPage />
        </ProShell>
      </ProProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-booking="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the tabs', () => {
  it('is a real tablist with three tabs and a panel labelled by the selected one', async () => {
    mockApi([booking('up', 'confirmed', 48)]);
    renderPage();
    const list = await screen.findByRole('tablist', { name: 'فیلتر رزروها' });
    expect(within(list).getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /پیش‌رو/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: /پیش‌رو/ })).toBeInTheDocument();
  });

  it('gives a cancelled booking its own tab, and keeps an expired one in the past — nobody cancelled it', async () => {
    mockApi([
      booking('up', 'confirmed', 48),
      booking('done', 'completed', -48),
      booking('lapsed', 'expired', -72),
      booking('called', 'cancelled', -96),
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('tab', { name: /پیش‌رو \(۱\)/ });
    expect(screen.getByRole('tab', { name: /گذشته \(۲\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /لغوشده \(۱\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /لغوشده/ }));
    expect(row('called')).not.toBeNull();
    expect(row('lapsed')).toBeNull();
    expect(row('up')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /گذشته/ }));
    expect(row('lapsed')).not.toBeNull();
    expect(row('done')).not.toBeNull();
    expect(row('called')).toBeNull();
  });

  it('gives each tab its own empty sentence', async () => {
    mockApi([booking('up', 'confirmed', 48)]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('tab', { name: /پیش‌رو \(۱\)/ });
    await user.click(screen.getByRole('tab', { name: /لغوشده/ }));
    expect(await screen.findByText('رزرو لغوشده‌ای ندارید.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /گذشته/ }));
    expect(await screen.findByText('هنوز رزرو گذشته‌ای ندارید.')).toBeInTheDocument();
  });
});

/**
 * One number, two places that show it — #282.
 *
 * Before this, the «پیش‌رو» tab counted the pages it HELD and marked the
 * shortfall with a `+`, because the true total was unreadable. The navigation's
 * badge counts everything. Two numbers under one word is the failure these cases
 * exist to prevent, so each is written to fail if EITHER surface goes back to
 * counting for itself.
 */
describe('the badge and the tab label are the same number', () => {
  it('both follow the server, even when it disagrees with the rows on screen', async () => {
    // Two rows held, sixty-two upcoming in total. Anything deriving a figure
    // from what is loaded would say ۲.
    mockApi([booking('a', 'confirmed', 24), booking('b', 'confirmed', 48)], {}, 62);
    renderWithShell();

    await waitFor(() => expect(screen.queryByTestId('pro-nav-upcoming-count')).not.toBeNull());
    expect(screen.getByTestId('pro-nav-upcoming-count')).toHaveTextContent('۶۲');
    expect(screen.getByRole('tab', { name: /پیش‌رو \(۶۲\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /پیش‌رو \(۲\)/ })).toBeNull();
  });

  it('carries no “+” on «پیش‌رو», because that number is no longer an approximation', async () => {
    // The other two tabs keep theirs: no route counts them, so "at least this
    // many" stays the honest thing for them to say.
    mockApi([booking('a', 'confirmed', 24), booking('done', 'completed', -48)], {}, 7);
    renderWithShell();

    expect(await screen.findByRole('tab', { name: 'پیش‌رو (۷)' })).toBeInTheDocument();
  });

  it('shows no figure on either surface when the count cannot be read, rather than two different guesses', async () => {
    mockApi([booking('a', 'confirmed', 24), booking('b', 'confirmed', 48)], {}, 'fails');
    renderWithShell();

    expect(await screen.findByRole('tab', { name: 'پیش‌رو' })).toBeInTheDocument();
    expect(screen.queryByTestId('pro-nav-upcoming-count')).toBeNull();
    // Specifically not a fallback to the rows it holds — that is the second
    // source this change removed.
    expect(screen.queryByRole('tab', { name: /پیش‌رو \(/ })).toBeNull();
  });
});

describe('grouping by day', () => {
  it('shows the customer name and never falls back to a raw identity id', async () => {
    mockApi([booking('up', 'confirmed', 48)]);
    renderPage();
    await screen.findByText('مشتری: مریم احمدی');
    const bookingRow = row('up');

    expect(bookingRow).not.toBeNull();
    expect(bookingRow?.textContent).toContain('مشتری: مریم احمدی');
    expect(bookingRow?.textContent).not.toContain('cust-abcdef12');
  });

  it('renders a neutral fallback when the customer has no display name', async () => {
    mockApi([{ ...booking('up', 'confirmed', 48), customerDisplayName: null }]);
    renderPage();
    await screen.findByText('مشتری: نام مشتری ثبت نشده');
    const bookingRow = row('up');

    expect(bookingRow?.textContent).toContain('مشتری: نام مشتری ثبت نشده');
    expect(bookingRow?.textContent).not.toContain('cust-abcdef12');
  });

  it('puts two bookings on the same platform-local day under one heading, and another day under another', async () => {
    // Two bookings an hour apart that are safely mid-day in Tehran, and one two days later.
    const noon = new Date();
    noon.setUTCHours(8, 30, 0, 0); // 12:00 in Asia/Tehran
    const base = noon.getTime() + 2 * DAY;
    const at = (id: string, ms: number) => ({
      ...booking(id, 'confirmed', 0),
      startAt: new Date(ms).toISOString(),
      endAt: new Date(ms + HOUR).toISOString(),
    });
    mockApi([at('a', base), at('b', base + HOUR), at('c', base + 2 * DAY)]);
    renderPage();
    await screen.findByRole('tab', { name: /پیش‌رو \(۳\)/ });
    const headings = document.querySelectorAll('[data-day]');
    expect(headings).toHaveLength(2);
    expect(headings[0].querySelectorAll('[data-booking]')).toHaveLength(2);
    expect(headings[1].querySelectorAll('[data-booking]')).toHaveLength(1);
  });

  it('sets each time of day as its own left-to-right run', async () => {
    mockApi([booking('up', 'confirmed', 48)]);
    renderPage();
    await screen.findByRole('tab', { name: /پیش‌رو \(۱\)/ });
    const clocks = (row('up') as HTMLElement).querySelectorAll('span');
    expect([...clocks].some((s) => s.className.includes('clock'))).toBe(true);
  });
});

describe('the confirmation dialogs', () => {
  it('describes its consequence to assistive technology, not just its title', async () => {
    mockApi([booking('up', 'confirmed', 48)]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'ثبت انجام نوبت' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleDescription(/برگشت‌پذیر نیست/);
  });
});

describe('the history', () => {
  it('never shows a raw event key, and says what it can from the transition', async () => {
    mockApi([booking('up', 'confirmed', 48)], {
      '/history': () =>
        ok([
          { id: 'h1', event: 'auto_released', fromStatus: 'confirmed', toStatus: 'expired', actorType: 'system', reason: null, metadata: null, createdAt: new Date().toISOString() },
          { id: 'h2', event: 'something_new', fromStatus: null, toStatus: null, actorType: null, reason: null, metadata: null, createdAt: new Date().toISOString() },
        ]),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'تاریخچه' }));
    await waitFor(() => expect(screen.getByText('انقضای رزرو')).toBeInTheDocument());
    expect(screen.getByText('تغییر وضعیت رزرو')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/auto_released|something_new/);
  });

  /**
   * Regression for a bug the `BookingRow`/`AuditTrail` extraction surfaced:
   * the error state's retry button used to call the same toggle function
   * that opens and closes the panel. Since the panel is already open when
   * the retry button renders, that call matched the toggle's "already open"
   * branch and CLOSED the panel instead of retrying the fetch — no second
   * request ever went out. Pins both halves: a second request must be made,
   * and the panel must still be open (not fall back to "تاریخچه") when it
   * succeeds.
   */
  it('retries the fetch without closing the panel, after a failed load', async () => {
    let historyCalls = 0;
    mockApi([booking('up', 'confirmed', 48)], {
      '/history': () => {
        historyCalls += 1;
        return historyCalls === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : ok([
              { id: 'h1', event: 'auto_released', fromStatus: 'confirmed', toStatus: 'expired', actorType: 'system', reason: null, metadata: null, createdAt: new Date().toISOString() },
            ]);
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'تاریخچه' }));
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(historyCalls).toBe(1);
    // Still open while the first attempt is showing its error.
    expect(screen.getByRole('button', { name: 'بستن تاریخچه' })).toBeInTheDocument();

    await user.click(retry);

    await waitFor(() => expect(historyCalls).toBe(2));
    await waitFor(() => expect(screen.getByText('انقضای رزرو')).toBeInTheDocument());
    // Still open after the retry succeeds — the buggy version closed it and
    // this button would have reverted to "تاریخچه".
    expect(screen.getByRole('button', { name: 'بستن تاریخچه' })).toBeInTheDocument();
  });
});
