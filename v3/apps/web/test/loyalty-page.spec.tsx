import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoyaltyPage from '@/app/loyalty/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import { ProgressBar } from '@/components/kit';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/loyalty',
}));

/**
 * The customer club, against `10_LOYALTY.md`.
 *
 * Two facts that predate the redesign and must survive it: the progress bar is
 * a real `progressbar` with `aria-valuenow/min/max`, and the balance and the
 * lifetime total are two different numbers shown side by side.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }) });

const SUMMARY = {
  balance: 120,
  lifetimeEarned: 480,
  tier: { slug: 'silver', name: 'نقره‌ای', thresholdPoints: 300 },
  nextTier: { slug: 'gold', name: 'طلایی', thresholdPoints: 600 },
  pointsToNextTier: 120,
  percentToNextTier: 42.857142,
  membership: null,
  benefits: [],
};

const ROW = (over: Record<string, unknown>) => ({
  id: 'h1',
  points: 20,
  basePoints: 20,
  multiplierBp: 10000,
  reason: 'booking_completed',
  createdAt: '2026-08-01T06:30:00.000Z',
  ...over,
});

type Handlers = {
  summary?: unknown;
  history?: (page: number) => { items: unknown[]; totalPages: number };
  extra?: Record<string, () => Promise<unknown>>;
};

function mockApi({ summary = SUMMARY, history = () => ({ items: [ROW({})], totalPages: 1 }), extra = {} }: Handlers = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/loyalty/summary')) return ok(summary);
    if (url.includes('/loyalty/history')) {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
      const { items, totalPages } = history(page);
      return ok({ items, pagination: { page, totalPages } });
    }
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <LoyaltyPage />
    </AuthProvider>,
  );
}

const entry = (id: string) => document.querySelector(`[data-entry="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('ProgressBar', () => {
  it('is a named progressbar with min/max and a rounded now', () => {
    render(<ProgressBar value={42.857142} label="پیشرفت تا سطح طلایی" />);
    const bar = screen.getByRole('progressbar', { name: 'پیشرفت تا سطح طلایی' });
    expect(bar).toHaveAttribute('aria-valuenow', '43');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it.each([
    [-5, '0'],
    [140, '100'],
    [Number.NaN, '0'],
  ])('clamps %s to a value inside 0–100 (%s)', (value, expected) => {
    render(<ProgressBar value={value} label="x" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', expected);
  });
});

describe('loyalty page', () => {
  it('shows the balance and the lifetime total as two separate figures', async () => {
    mockApi();
    renderPage();
    const card = await screen.findByTestId('loyalty-summary');
    expect(within(card).getByText('امتیاز قابل استفاده').nextElementSibling).toHaveTextContent('۱۲۰');
    expect(within(card).getByText('مجموع امتیاز کسب‌شده').nextElementSibling).toHaveTextContent('۴۸۰');
  });

  it('states the progress to the next level in words, as a percentage, and as a progressbar', async () => {
    mockApi();
    renderPage();
    const card = await screen.findByTestId('loyalty-summary');
    expect(within(card).getByText('۱۲۰ امتیاز تا سطح طلایی')).toBeInTheDocument();
    expect(within(card).getByText('۴۳٪')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar', { name: 'پیشرفت تا سطح طلایی' })).toHaveAttribute('aria-valuenow', '43');
  });

  it('shows no progress bar at the top level, where there is nothing to progress to', async () => {
    mockApi({ summary: { ...SUMMARY, nextTier: null, pointsToNextTier: null, percentToNextTier: null } });
    renderPage();
    await screen.findByTestId('loyalty-summary');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('marks an inactive membership in words', async () => {
    mockApi({ summary: { ...SUMMARY, membership: { planId: 'p', planName: 'ویژه', status: 'expired', source: 's', startedAt: '2026-01-01T00:00:00.000Z', expiresAt: null } } });
    renderPage();
    expect(await screen.findByText('غیرفعال')).toBeInTheDocument();
  });
});

describe('loyalty page — the history', () => {
  it('prints the sign of every row, so a reversal is not told apart by colour alone', async () => {
    mockApi({
      history: () => ({
        items: [ROW({ id: 'a', points: 20 }), ROW({ id: 'b', points: -20, reason: 'referral_referrer_reversal' })],
        totalPages: 1,
      }),
    });
    renderPage();
    await screen.findByTestId('loyalty-summary');
    expect(entry('a')).toHaveTextContent('+۲۰');
    expect(entry('b')).toHaveTextContent('−۲۰');
  });

  it('names the referral reasons in Persian — they used to fall through to the raw key', async () => {
    mockApi({
      history: () => ({
        items: [
          ROW({ id: 'a', reason: 'referral_referrer_reward' }),
          ROW({ id: 'b', reason: 'referral_referee_reward' }),
          ROW({ id: 'c', reason: 'referral_referrer_reversal', points: -20 }),
          ROW({ id: 'd', reason: 'referral_referee_reversal', points: -20 }),
        ],
        totalPages: 1,
      }),
    });
    renderPage();
    await screen.findByTestId('loyalty-summary');
    for (const id of ['a', 'b', 'c', 'd']) expect(entry(id).textContent).not.toMatch(/referral_/);
    expect(entry('a')).toHaveTextContent('پاداش معرفی دوستان');
    expect(entry('c')).toHaveTextContent('برگشت پاداش معرفی');
  });

  it('never shows a raw key for a reason it has never heard of', async () => {
    mockApi({ history: () => ({ items: [ROW({ id: 'a', reason: 'some_new_reason' })], totalPages: 1 }) });
    renderPage();
    await screen.findByTestId('loyalty-summary');
    expect(entry('a').textContent).not.toMatch(/some_new_reason/);
    expect(entry('a')).toHaveTextContent('امتیاز باشگاه');
  });

  it('explains a boosted award', async () => {
    mockApi({ history: () => ({ items: [ROW({ id: 'a', points: 30, basePoints: 20, multiplierBp: 15000 })], totalPages: 1 }) });
    renderPage();
    await screen.findByTestId('loyalty-summary');
    expect(entry('a')).toHaveTextContent('پایه: ۲۰');
  });

  it('says plainly that there is no history', async () => {
    mockApi({ history: () => ({ items: [], totalPages: 1 }) });
    renderPage();
    expect(await screen.findByText('هنوز امتیازی ثبت نشده است.')).toBeInTheDocument();
  });

  it('offers “more” only while the server has another page, and appends without duplicating', async () => {
    mockApi({
      history: (page) =>
        page === 1
          ? { items: [ROW({ id: 'a' })], totalPages: 2 }
          : { items: [ROW({ id: 'a' }), ROW({ id: 'b', reason: 'review_submitted' })], totalPages: 2 },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'نمایش بیشتر' }));
    await waitFor(() => expect(entry('b')).not.toBeNull());
    expect(document.querySelectorAll('[data-entry]')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'نمایش بیشتر' })).toBeNull();
  });

  it('offers no “more” when everything fit on one page', async () => {
    mockApi();
    renderPage();
    await screen.findByTestId('loyalty-summary');
    expect(screen.queryByRole('button', { name: 'نمایش بیشتر' })).toBeNull();
  });
});

describe('loyalty page — a failed load', () => {
  it('offers a retry, and retrying asks again', async () => {
    mockApi({ extra: { '/loyalty/summary': fail } });
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    const before = (global.fetch as jest.Mock).mock.calls.filter(([u]) => String(u).includes('/loyalty/summary')).length;
    await user.click(retry);
    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.filter(([u]) => String(u).includes('/loyalty/summary')).length).toBeGreaterThan(before),
    );
  });
});
