import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WaitlistPage from '@/app/waitlist/page';
import { AuthProvider } from '@/lib/auth-context';
import { remainingLabel } from '@/lib/remaining-time';
import { tokenStorage } from '@/lib/token-storage';

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push }),
  usePathname: () => '/waitlist',
}));

/**
 * The waitlist, against `11_WAITLIST.md`.
 *
 * What matters here is the one row that asks for something before a clock
 * runs out: a live offer. It must say how long is left, in words; it must be
 * announced; and the three actions the API offers must each be reachable from
 * exactly the states that allow them.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

const BASE = {
  customerId: 'u1',
  professionalId: 'p1',
  serviceId: null,
  offeredSlotId: null,
  offerExpiresAt: null,
  resultingBookingId: null,
  createdAt: '2026-08-01T06:30:00.000Z',
};

const WAITING = { ...BASE, id: 'w1', status: 'waiting' as const };
const OFFERED = {
  ...BASE,
  id: 'w2',
  status: 'offered' as const,
  offeredSlotId: 'slot-1',
  // Far in the future, so the row is a live offer whenever the suite runs.
  offerExpiresAt: '2099-01-01T08:30:00.000Z',
};
const MISSED = { ...BASE, id: 'w3', status: 'missed' as const };

function mockApi(entries: unknown[], extra: Record<string, () => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/v1/me/waitlist') || url.includes('/v1/waitlist')) return ok(entries);
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <WaitlistPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  push.mockClear();
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('remainingLabel', () => {
  const NOW = Date.parse('2026-09-21T10:00:00.000Z');
  const at = (ms: number) => new Date(NOW + ms).toISOString();

  it.each([
    [90_000, '۱ دقیقه مانده'],
    [25 * 60_000 + 10_000, '۲۵ دقیقه مانده'],
    [59 * 60_000 + 59_000, '۵۹ دقیقه مانده'],
    [60 * 60_000, '۱ ساعت مانده'],
    [2 * 3_600_000 + 5 * 60_000, '۲ ساعت و ۵ دقیقه مانده'],
  ])('says %i ms remaining as “%s”', (ms, expected) => {
    expect(remainingLabel(at(ms), NOW)).toBe(expected);
  });

  it('says the deadline has passed at and below one minute, rather than showing zero or a negative', () => {
    expect(remainingLabel(at(59_000), NOW)).toBe('مهلت پاسخ به پایان رسیده است.');
    expect(remainingLabel(at(0), NOW)).toBe('مهلت پاسخ به پایان رسیده است.');
    expect(remainingLabel(at(-3_600_000), NOW)).toBe('مهلت پاسخ به پایان رسیده است.');
  });
});

describe('waitlist page', () => {
  it('shows the deadline of a live offer as a clock time AND as time remaining, with the clock isolated left-to-right', async () => {
    mockApi([OFFERED]);
    renderPage();
    const row = await waitFor(() => {
      const found = document.querySelector('[data-entry="w2"]');
      if (!found) throw new Error('no row yet');
      return found as HTMLElement;
    });
    // 08:30 UTC is 12:00 in Asia/Tehran; the assertion names an absolute
    // instant so it does not depend on the runner's own zone.
    const clock = within(row).getByText('۱۲:۰۰');
    expect(clock.tagName).toBe('SPAN');
    expect(clock.className).toContain('clock');
    expect(within(row).getByText(/مانده$/)).toBeInTheDocument();
  });

  it('offers accept and decline on an offer, and leave on a waiting entry — never the wrong one', async () => {
    mockApi([WAITING, OFFERED, MISSED]);
    renderPage();
    await screen.findByText('نوبت پیشنهاد شده');

    const offer = document.querySelector('[data-entry="w2"]') as HTMLElement;
    expect(within(offer).getByRole('button', { name: 'پذیرفتن و رزرو' })).toBeInTheDocument();
    expect(within(offer).getByRole('button', { name: 'رد کردن' })).toBeInTheDocument();
    expect(within(offer).queryByRole('button', { name: 'خروج از لیست انتظار' })).toBeNull();

    const waiting = document.querySelector('[data-entry="w1"]') as HTMLElement;
    expect(within(waiting).getByRole('button', { name: 'خروج از لیست انتظار' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('button', { name: 'پذیرفتن و رزرو' })).toBeNull();

    // A missed offer is history: nothing to press.
    const missed = document.querySelector('[data-entry="w3"]') as HTMLElement;
    expect(within(missed).queryAllByRole('button')).toHaveLength(0);
  });

  it('announces a waiting offer politely, and says nothing when there is none', async () => {
    mockApi([OFFERED]);
    const { unmount } = renderPage();
    await screen.findByText('نوبت پیشنهاد شده');
    expect(screen.getByRole('status')).toHaveTextContent('۱ پیشنهاد نوبت منتظر پاسخ شماست.');
    unmount();

    mockApi([WAITING]);
    renderPage();
    await screen.findByText('در صف انتظار');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('sends the customer to their bookings after accepting', async () => {
    mockApi([OFFERED], { '/accept': () => ok({}) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'پذیرفتن و رزرو' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/bookings'));
  });

  it('says plainly that there is nothing when the list is empty', async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText('در حال حاضر در هیچ لیست انتظاری قرار ندارید.')).toBeInTheDocument();
  });
});
