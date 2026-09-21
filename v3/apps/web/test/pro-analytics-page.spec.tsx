import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProAnalyticsPage from '@/app/pro/analytics/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/analytics',
}));

/**
 * The professional's analytics, against `07_PRO_ANALYTICS.md` and
 * `24_MONEYCHART_DECISION.md`. The page does no arithmetic of its own — every
 * figure is the server's — so what is asserted is what it chooses to show and
 * how it labels it: money as money, a counter nothing records as unknown
 * rather than zero, and a failed load as a failure rather than a quiet page.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = () => Promise.reject(new TypeError('Failed to fetch'));

const PROFILE = {
  id: 'prof-1',
  displayName: 'سالن آزمایشی',
  bio: null,
  cityId: null,
  specialties: [],
  verificationStatus: 'verified',
  createdAt: new Date().toISOString(),
};

const metric = (key: string, value: number) => ({ key, value, kind: 'event_derived' });

function metrics(over: { funnel?: Record<string, number>; revenue?: Record<string, number> } = {}) {
  const f = { created: 12, confirmed: 9, completed: 7, cancelled: 2, expired: 1, profileViews: 0, completionRate: 0.58, viewToBookingRate: 0, ...over.funnel };
  const r = { paidOrders: 5, grossToman: 4_500_000, refundedToman: 500_000, ...over.revenue };
  return {
    range: { from: '2026-08-22', to: '2026-09-21' },
    funnel: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, metric(k, v)])),
    revenue: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, metric(k, v)])),
  };
}

const POINTS = [
  { day: '2026-09-19', count: 2, sum: 900_000 },
  { day: '2026-09-20', count: 0, sum: 0 },
  { day: '2026-09-21', count: 3, sum: 1_800_000 },
];

function mockApi(opts: { metrics?: unknown; series?: unknown; extra?: Record<string, () => Promise<unknown>> } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(opts.extra ?? {})) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/v1/me/provider')) return ok(PROFILE);
    // The series route contains the metrics route as a prefix: match it first.
    if (url.includes('/v1/me/analytics/series')) return ok(opts.series ?? { eventType: 'BookingCompleted', points: POINTS });
    if (url.includes('/v1/me/analytics')) return ok(opts.metrics ?? metrics());
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProAnalyticsPage />
      </ProProvider>
    </AuthProvider>,
  );
}

const seriesCalls = () =>
  (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/analytics/series'));

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the funnel', () => {
  it('shows the server’s counters and its completion rate as a percentage', async () => {
    mockApi();
    renderPage();
    const created = (await screen.findByText('رزرو ثبت‌شده')).closest('div') as HTMLElement;
    expect(created).toHaveTextContent('۱۲');
    expect(screen.getByText('نرخ انجام').closest('div')).toHaveTextContent('۵۸٪');
  });

  it('says a counter nothing records is «به‌زودی», never a zero that reads as a fact', async () => {
    mockApi();
    renderPage();
    const card = (await screen.findByText('بازدید پروفایل')).closest('div') as HTMLElement;
    expect(card).toHaveTextContent('به‌زودی');
    expect(card).toHaveTextContent('—');
    expect(card).not.toHaveTextContent('۰');
  });

  it('does not let the unrecorded counter count as activity, so a quiet new account still gets the honest empty state', async () => {
    mockApi({ metrics: metrics({ funnel: { created: 0, confirmed: 0, completed: 0, cancelled: 0, expired: 0, profileViews: 9 } }) });
    renderPage();
    expect(await screen.findByText(/هنوز فعالیتی برای نمایش نیست/)).toBeInTheDocument();
    expect(screen.queryByText('نرخ انجام')).toBeNull();
  });
});

describe('revenue', () => {
  it('formats Toman measures as money and a count as a count', async () => {
    mockApi();
    renderPage();
    const gross = (await screen.findByText('فروش ناخالص')).closest('div') as HTMLElement;
    expect(gross).toHaveTextContent('۴٬۵۰۰٬۰۰۰');
    expect(screen.getByText('سفارش‌های پرداخت‌شده').closest('div')).toHaveTextContent(/^سفارش‌های پرداخت‌شده۵$/);
  });

  it('never shows a raw key for a figure it has never heard of', async () => {
    mockApi({ metrics: metrics({ revenue: { mysteryToman: 1 } }) });
    renderPage();
    await screen.findByText('فروش ناخالص');
    expect(document.body.textContent).not.toContain('mysteryToman');
    expect(screen.getByText('شاخص مالی')).toBeInTheDocument();
  });
});

describe('the daily trend', () => {
  it('plots a COUNT for a booking event, with the values in the accessible table', async () => {
    mockApi();
    renderPage();
    const table = await screen.findByRole('table', { name: /روند روزانهٔ نوبت‌های انجام‌شده/ });
    expect(within(table).getByRole('columnheader', { name: 'تعداد' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 days
  });

  it('plots gross SALES in Toman for paid orders — the metric is the order total — with the order count as the detail', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /نوبت‌های انجام‌شده/ });
    await user.selectOptions(screen.getByLabelText('رویداد'), 'OrderPaid');
    const table = await screen.findByRole('table', { name: /روند روزانهٔ فروش/ });
    expect(within(table).getByRole('columnheader', { name: 'فروش' })).toBeInTheDocument();
    expect(within(table).getByText(/۱٬۸۰۰٬۰۰۰ تومان/)).toBeInTheDocument(); // the unit is named
    expect(within(table).getByText(/۱٬۸۰۰٬۰۰۰/)).toBeInTheDocument(); // the sum, not the count
    expect(within(table).getByText('۳ سفارش')).toBeInTheDocument(); // the count, as detail
  });

  it('labels every day with a Persian date, not an ISO string', async () => {
    mockApi();
    renderPage();
    const table = await screen.findByRole('table', { name: /نوبت‌های انجام‌شده/ });
    expect(within(table).queryByText(/2026-09-2/)).toBeNull();
    expect(within(table).getAllByRole('rowheader')[0].textContent).toMatch(/۱۴۰۵/);
  });

  it('offers profile views only as «به‌زودی» and does not let it be chosen', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('رویداد');
    const option = screen.getByRole('option', { name: /بازدید از پروفایل/ });
    expect(option).toHaveTextContent('(به‌زودی)');
    expect(option).toBeDisabled();
  });

  it('says there is no data for the range instead of drawing a flat chart', async () => {
    mockApi({ series: { eventType: 'BookingCompleted', points: [] } });
    renderPage();
    expect(await screen.findByText('هنوز داده‌ای برای این بازه نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('asks the server for the chosen window, in platform days', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const before = seriesCalls().length;
    await user.click(screen.getByRole('button', { name: '۹۰ روز' }));
    await waitFor(() => expect(seriesCalls().length).toBeGreaterThan(before));
    const last = new URL(seriesCalls().at(-1) as string, 'http://x').searchParams;
    const span = (Date.parse(last.get('to') as string) - Date.parse(last.get('from') as string)) / 86_400_000;
    expect(span).toBeGreaterThanOrEqual(89);
    expect(span).toBeLessThanOrEqual(91);
  });
});

describe('a failed load', () => {
  it('shows the failure and a retry, and none of the figures', async () => {
    mockApi({ extra: { '/v1/me/analytics': fail } });
    renderPage();
    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByText('رزرو ثبت‌شده')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
