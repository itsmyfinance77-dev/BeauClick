import { render, screen, waitFor, within } from '@testing-library/react';
import ProOverviewPage from '@/app/pro/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro',
}));

/**
 * The professional's «امروز» — `Prototype - Pro and Admin.dc.html` §01.
 *
 * ## What this page is for
 *
 * A seller opens it to answer three questions: what is blocked, how am I
 * doing, and what is happening today. The design orders them that way and so
 * does the page, so the order is asserted rather than assumed.
 *
 * The blocked one earns its weight: a finished booking whose outcome has not
 * been recorded pays the seller nothing and earns the customer nothing.
 * Nothing else in the platform can move it, which is why it is a banner and
 * not a row in a list.
 *
 * ## And two numbers the page refuses to show
 *
 * «۱۸٪ بیشتر از ماه گذشته» has no route behind it — `FinanceSummary` is a
 * position, not a series — and a customer's name is not on a booking. The
 * design's own note calls the second the single data change this screen
 * needs. Neither is guessed.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

const HOUR = 3_600_000;

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    customerId: 'cust-1',
    professionalId: 'prof-1',
    serviceId: 'svc-1',
    slotId: 'slot-1',
    startAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    endAt: new Date(Date.now() + 5 * HOUR).toISOString(),
    status: 'confirmed' as const,
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'slot-free-1',
    startAt: new Date(Date.now() + 1 * HOUR).toISOString(),
    endAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    status: 'open' as const,
    serviceId: null,
    ...overrides,
  };
}

const SERVICES = [
  { id: 'svc-1', professionalId: 'prof-1', name: 'میکاپ عروس', durationMinutes: 120, priceToman: 850_000 },
];

function mockApi(options: {
  bookings?: unknown[];
  slots?: unknown[];
  services?: unknown[];
  workspaces?: unknown[];
  summary?: unknown;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['professional'], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) {
      return ok({
        id: 'prof-1',
        displayName: 'سارا محمدی',
        verificationStatus: 'verified',
        specialties: [{ id: 's1', name: 'میکاپ' }],
        cityId: 'c1',
      });
    }
    if (url.includes('/v1/me/finance/workspaces')) {
      return ok({ items: options.workspaces ?? [{ workspaceRef: 'w1', workspaceType: 'professional', accessMode: 'owner', displayLabel: 'من' }] });
    }
    if (url.includes('/summary')) {
      return ok(options.summary ?? { receivableNetToman: 4_380_000, receivableGrossToman: 5_000_000, commissionToman: 620_000 });
    }
    // Ordered most-specific first: '/v1/me/professional-bookings' also
    // contains 'bookings', and '/v1/me/availability' is the slot list.
    if (url.includes('/v1/me/professional-bookings')) return ok(options.bookings ?? [booking()]);
    if (url.includes('/v1/me/availability')) return ok(options.slots ?? [slot()]);
    if (url.includes('/services')) return ok(options.services ?? SERVICES);
    return ok([]);
  });
}

function renderPro() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProOverviewPage />
      </ProProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the blocked work comes first', () => {
  it('names the count and says what it costs, when something is waiting', async () => {
    const finished = booking({
      id: 'done',
      startAt: new Date(Date.now() - 5 * HOUR).toISOString(),
      endAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    mockApi({ bookings: [finished, booking()] });
    renderPro();

    const banner = await screen.findByTestId('awaiting-action');
    expect(banner.textContent).toContain('۱ نوبت گذشته منتظر ثبت وضعیت است');
    // The consequence, not just the count: this is money sitting still.
    expect(banner.textContent).toContain('درآمد این نوبت‌ها به مالی شما');
    expect(within(banner).getByRole('link', { name: 'ثبت وضعیت' })).toHaveAttribute('href', '/pro/bookings');
  });

  it('is absent when nothing is waiting, rather than showing a zero', async () => {
    mockApi({ bookings: [booking()] });
    renderPro();

    await screen.findByTestId('today-timeline');
    expect(screen.queryByTestId('awaiting-action')).toBeNull();
  });
});

describe('the three tiles', () => {
  it('shows the net receivable when the seller owns exactly one workspace', async () => {
    mockApi();
    renderPro();

    const tiles = await screen.findByTestId('pro-tiles');
    await waitFor(() => expect(tiles.textContent).toContain('۴٬۳۸۰٬۰۰۰'));
  });

  it('sends a dual owner to choose, rather than picking a workspace for them', async () => {
    mockApi({
      workspaces: [
        { workspaceRef: 'w1', workspaceType: 'professional', accessMode: 'owner', displayLabel: 'من' },
        { workspaceRef: 'w2', workspaceType: 'business', accessMode: 'owner', displayLabel: 'سالن' },
      ],
    });
    renderPro();

    const tiles = await screen.findByTestId('pro-tiles');
    // `V33-DEC-020`: there is no honest single figure for such a caller.
    await waitFor(() => expect(tiles.textContent).toContain('چند فضای کاری دارید'));
    expect(within(tiles).getByRole('link', { name: /صفحهٔ مالی/ })).toHaveAttribute('href', '/finance');
    expect(tiles.textContent).not.toContain('۴٬۳۸۰٬۰۰۰');
  });

  it('shows no month-over-month trend, because no route answers one', async () => {
    mockApi();
    renderPro();
    const tiles = await screen.findByTestId('pro-tiles');

    // The artboard's «۱۸٪ بیشتر از ماه گذشته» needs a series, and
    // `FinanceSummary` is a position.
    expect(tiles.textContent).not.toContain('بیشتر از ماه گذشته');
    expect(tiles.textContent).not.toMatch(/٪/);
  });

  it('gives the week bar an accessible name and a real proportion', async () => {
    mockApi({ bookings: [booking()], slots: [slot(), slot({ id: 'slot-free-2' }), slot({ id: 'slot-free-3' })] });
    renderPro();

    const tiles = await screen.findByTestId('pro-tiles');
    const bar = within(tiles).getByRole('progressbar');
    // One booking of four times = 25%.
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '25'));
    expect(bar.getAttribute('aria-label')).toContain('این هفته');
  });
});

describe('today’s timeline', () => {
  it('merges bookings and free hours into one list, in the order the day happens', async () => {
    mockApi({
      bookings: [booking({ id: 'later', startAt: new Date(Date.now() + 6 * HOUR).toISOString(), endAt: new Date(Date.now() + 7 * HOUR).toISOString() })],
      slots: [slot({ id: 'earlier' })],
    });
    renderPro();

    const timeline = await screen.findByTestId('today-timeline');
    // A seller should not have to interleave two lists in their head.
    const kinds = [...timeline.querySelectorAll('[data-entry]')].map((r) => r.getAttribute('data-entry'));
    expect(kinds).toEqual(['free', 'booking']);
  });

  it('never shows a customer’s name, because a booking does not carry one', async () => {
    mockApi();
    renderPro();
    const timeline = await screen.findByTestId('today-timeline');

    expect(timeline.textContent).toContain('میکاپ عروس');
    expect(timeline.textContent).not.toContain('cust-1');
  });

  it('calls the free-hour control what it does, not what the drawing says', async () => {
    mockApi({ bookings: [], slots: [slot()] });
    renderPro();
    const timeline = await screen.findByTestId('today-timeline');

    // The artboard says «مسدود کردن». In the API it is a DELETE, and a
    // control whose word is softer than its effect is the wrong word.
    expect(within(timeline).getByRole('link', { name: 'حذف این زمان' })).toBeInTheDocument();
    expect(timeline.textContent).not.toContain('مسدود کردن');
  });

  it('says the day is empty rather than rendering a heading over nothing', async () => {
    mockApi({ bookings: [], slots: [] });
    renderPro();

    expect(await screen.findByText(/نه نوبتی ثبت شده و نه زمان آزادی باز است/)).toBeInTheDocument();
  });
});

describe('the setup checklist', () => {
  it('appears only while something is genuinely missing', async () => {
    mockApi({ services: [] });
    renderPro();

    const checklist = await screen.findByTestId('setup-checklist');
    const steps = [...checklist.querySelectorAll('[data-step-done]')];
    expect(steps).toHaveLength(4);
    expect(steps.filter((s) => s.getAttribute('data-step-done') === 'false')).toHaveLength(1);
  });

  it('is gone once everything is done', async () => {
    mockApi();
    renderPro();

    await screen.findByTestId('today-timeline');
    expect(screen.queryByTestId('setup-checklist')).toBeNull();
  });
});
