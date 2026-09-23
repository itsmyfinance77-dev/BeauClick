import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProBookingsPage from '@/app/pro/bookings/page';
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

function mockApi(list: unknown[], extra: Record<string, () => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/v1/me/provider')) return ok(PROFILE);
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
});
