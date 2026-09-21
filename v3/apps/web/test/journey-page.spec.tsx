import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import JourneyPage from '@/app/journey/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/journey',
}));

/**
 * The beauty journey, against `09_JOURNEY.md`.
 *
 * The property that predates the redesign and must survive it: the profile
 * editor is never shown over a failed load. `notes` and `budget` start empty,
 * so an editor rendered anyway would show a blank form over data that still
 * exists, and saving it would send nulls and destroy the real profile.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }) });

const PROFILE = { preferredCityId: null, preferredSpecialtyIds: [], budgetMinToman: null, budgetMaxToman: 2000000, notes: 'پوست حساس' };
const GOAL = (over: Record<string, unknown>) => ({
  id: 'g1',
  title: 'آماده شدن برای عروسی',
  specialtyId: null,
  cityId: null,
  budgetToman: null,
  targetDate: null,
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});
const ENTRY = (over: Record<string, unknown>) => ({
  type: 'goal_created',
  label: 'هدف زیبایی تعریف شد',
  sourceType: 'goal',
  sourceId: 's1',
  metadata: {},
  occurredAt: '2026-08-01T06:30:00.000Z',
  ...over,
});

type Handlers = {
  goals?: unknown[];
  timeline?: (page: number) => { items: unknown[]; totalPages: number };
  extra?: Record<string, () => Promise<unknown>>;
};

function mockApi({ goals = [GOAL({})], timeline = () => ({ items: [ENTRY({})], totalPages: 1 }), extra = {} }: Handlers = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/journey/profile')) return ok(PROFILE);
    if (url.includes('/journey/goals')) return ok(goals);
    if (url.includes('/journey/timeline')) {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
      const { items, totalPages } = timeline(page);
      return ok({ items, pagination: { page, totalPages } });
    }
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <JourneyPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('journey — a failed load', () => {
  it('shows the failure and a retry, and never the profile editor', async () => {
    mockApi({ extra: { '/journey/profile': fail } });
    renderPage();
    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByLabelText('یادداشت‌های شخصی')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ذخیره' })).toBeNull();
  });
});

describe('journey — the profile', () => {
  it('seeds the editor from the server’s copy and states the privacy guarantee beside the notes', async () => {
    mockApi();
    renderPage();
    const notes = await screen.findByLabelText('یادداشت‌های شخصی');
    expect(notes).toHaveValue('پوست حساس');
    expect(notes).toHaveAccessibleDescription(/هرگز به دستیار هوشمند ارسال نمی‌شود/);
  });
});

describe('journey — goals', () => {
  it('tells an active goal apart from an achieved and an abandoned one, in words', async () => {
    mockApi({
      goals: [
        GOAL({ id: 'g1', title: 'اول' }),
        GOAL({ id: 'g2', title: 'دوم', status: 'achieved' }),
        GOAL({ id: 'g3', title: 'سوم', status: 'abandoned' }),
      ],
    });
    renderPage();
    await screen.findByText('اول');
    const goal = (id: string) => document.querySelector(`[data-goal="${id}"]`) as HTMLElement;

    expect(within(goal('g1')).getByRole('button', { name: 'محقق شد' })).toBeInTheDocument();
    expect(within(goal('g2')).queryByRole('button')).toBeNull();
    expect(within(goal('g2')).getByText('محقق شد')).toBeInTheDocument();
    expect(within(goal('g3')).getByText('رها شد')).toBeInTheDocument();
  });

  it('shows a goal’s target date as a Jalali date, and nothing when there is none', async () => {
    mockApi({ goals: [GOAL({ id: 'g1', targetDate: '2026-10-01T00:00:00.000Z' }), GOAL({ id: 'g2', title: 'بدون تاریخ' })] });
    renderPage();
    await screen.findByText('بدون تاریخ');
    const dated = document.querySelector('[data-goal="g1"]') as HTMLElement;
    expect(within(dated).getByText(/^تا /)).toBeInTheDocument();
    expect(within(document.querySelector('[data-goal="g2"]') as HTMLElement).queryByText(/^تا /)).toBeNull();
  });

  it('says plainly that there are no goals', async () => {
    mockApi({ goals: [] });
    renderPage();
    expect(await screen.findByText('هنوز هدفی ثبت نکرده‌اید.')).toBeInTheDocument();
  });

  it('marks a goal achieved through the API', async () => {
    mockApi({ extra: { '/journey/goals/g1': () => ok({ id: 'g1', status: 'achieved' }) } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'محقق شد' }));
    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([u, init]) => String(u).includes('/journey/goals/g1') && init?.method === 'PATCH'),
      ).toBe(true),
    );
  });
});

describe('journey — the timeline', () => {
  it('names each entry’s kind in words, and shows the server’s label', async () => {
    mockApi({
      timeline: () => ({
        items: [ENTRY({ type: 'booking_created', label: 'رزرو ثبت شد', sourceId: 'b1' }), ENTRY({ type: 'order_paid', label: 'پرداخت انجام شد', sourceId: 'o1' })],
        totalPages: 1,
      }),
    });
    renderPage();
    const list = await screen.findByRole('list', { name: 'تاریخچهٔ فعالیت‌ها' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first).getByText('رزرو', { selector: 'span' })).toBeInTheDocument();
    expect(within(first).getByText('رزرو ثبت شد')).toBeInTheDocument();
    expect(within(second).getByText('پرداخت', { selector: 'span' })).toBeInTheDocument();
  });

  it('never shows a raw enum key for an event type the client does not know', async () => {
    mockApi({ timeline: () => ({ items: [ENTRY({ type: 'booking_refunded', label: 'booking_refunded', sourceId: 'x' })], totalPages: 1 }) });
    renderPage();
    const list = await screen.findByRole('list', { name: 'تاریخچهٔ فعالیت‌ها' });
    expect(within(list).queryByText('booking_refunded')).toBeNull();
    expect(within(list).getByText('فعالیت')).toBeInTheDocument();
  });

  it('offers “more” only while the server has another page, and appends without duplicating', async () => {
    mockApi({
      timeline: (page) =>
        page === 1
          ? { items: [ENTRY({ sourceId: 'a', label: 'هدف زیبایی تعریف شد' })], totalPages: 2 }
          : // Page 2 repeats entry `a` (one was written between the two requests) and adds `b`.
            { items: [ENTRY({ sourceId: 'a' }), ENTRY({ type: 'goal_achieved', label: 'هدف زیبایی محقق شد', sourceId: 'b' })], totalPages: 2 },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'نمایش بیشتر' }));
    await screen.findByText('هدف زیبایی محقق شد');
    expect(within(screen.getByRole('list', { name: 'تاریخچهٔ فعالیت‌ها' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'نمایش بیشتر' })).toBeNull();
  });

  it('offers no “more” when everything fit on one page', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('list', { name: 'تاریخچهٔ فعالیت‌ها' });
    expect(screen.queryByRole('button', { name: 'نمایش بیشتر' })).toBeNull();
  });
});
