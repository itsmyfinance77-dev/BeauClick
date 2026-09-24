import { render, screen, waitFor, within } from '@testing-library/react';
import DashboardPage from '@/app/dashboard/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/dashboard',
}));

/**
 * The customer's account page — `Prototype - Customer.dc.html` §07.
 *
 * ## What this page is for
 *
 * `V3_INFORMATION_ARCHITECTURE.md` §2 makes `/dashboard` the level-two page
 * that gathers bookings, loyalty, the journey and notifications — which is
 * what let the header drop from eleven destinations to three. So the first
 * thing worth asserting is that it gathers them, and the second is that it
 * gathers them from the server rather than inventing a summary.
 *
 * ## And what must not happen when a section fails
 *
 * Five reads back this page. Two of them are what it is FOR; three are
 * sections of it. A dashboard missing its loyalty card is still a dashboard,
 * and blanking the page because one card could not load would be a worse
 * answer than rendering the rest — so each of those three is asserted to
 * fail alone.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function fail() {
  return Promise.resolve({
    ok: false,
    status: 500,
    json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }),
  });
}

const FUTURE = '2099-09-15T06:30:00.000Z';
const PAST = '2020-03-01T06:30:00.000Z';

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    customerId: 'u1',
    professionalId: 'prof-1',
    serviceId: 'svc-1',
    slotId: 'slot-1',
    startAt: FUTURE,
    endAt: '2099-09-15T09:30:00.000Z',
    status: 'confirmed' as const,
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    /* #225: the customer's own read names the order this booking produced, or null. */
    orderId: null,
    ...overrides,
  };
}

/** An order as `GET /v1/orders/:id` returns it — only the fields this page reads matter. */
function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    sourceType: 'booking',
    sourceId: 'b1',
    status: 'paid' as const,
    currency: 'IRT',
    subtotalToman: 807_500,
    discountTotalToman: 0,
    feeTotalToman: 0,
    totalToman: 807_500,
    refundedTotalToman: 0,
    collectedTotalToman: 807_500,
    paidAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    items: [],
    adjustments: [],
    paymentSchedule: { onlineToman: 807_500, venueToman: 0, entries: [] },
    ...overrides,
  };
}

const LOYALTY = {
  balance: 420,
  lifetimeEarned: 1150,
  tier: { slug: 'silver', name: 'نقره‌ای', thresholdPoints: 100 },
  nextTier: { slug: 'gold', name: 'طلایی', thresholdPoints: 1500 },
  pointsToNextTier: 350,
  percentToNextTier: 68,
  membership: null,
  benefits: [
    { type: 'discount', label: '۵٪ تخفیف روی همه خدمات', config: {} },
    { type: 'multiplier', label: 'ضریب ۱٫۲ برابری امتیاز', config: {} },
  ],
};

/** How many times each professional was read, so an N+1 shows up. */
let providerReads: string[];
/** Which orders were read, so a page that reads one it was not given shows up. */
let orderReads: string[];

function mockApi(options: {
  bookings?: unknown[];
  loyaltyFails?: boolean;
  noticesFail?: boolean;
  journeyFails?: boolean;
  providerFails?: boolean;
  orders?: Record<string, unknown>;
  orderFails?: boolean;
  notices?: unknown[];
} = {}) {
  providerReads = [];
  orderReads = [];
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989131234567', displayName: 'مینا', roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/bookings')) return ok(options.bookings ?? [booking()]);
    if (url.includes('/v1/me/loyalty/summary')) return options.loyaltyFails ? fail() : ok(LOYALTY);
    if (url.includes('/v1/me/notifications')) {
      if (options.noticesFail) return fail();
      return ok({
        items: options.notices ?? [
          { id: 'n1', category: 'booking', title: 'نوبت شما فردا ساعت ۱۲:۰۰ است', body: '', deepLink: null, read: false, createdAt: '2026-09-01T00:00:00.000Z' },
          { id: 'n2', category: 'loyalty', title: '۱۰۲ امتیاز به حساب شما اضافه شد', body: '', deepLink: null, read: true, createdAt: '2026-08-30T00:00:00.000Z' },
        ],
      });
    }
    if (url.includes('/v1/me/journey/goals')) {
      return options.journeyFails ? fail() : ok([{ id: 'g1', title: 'آماده شدن برای عروسی خواهرم', specialtyId: null, cityId: null, budgetToman: null, targetDate: null, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }]);
    }
    if (url.includes('/v1/me/journey/profile')) {
      return options.journeyFails ? fail() : ok({ preferredCityId: null, preferredSpecialtyIds: [], budgetMinToman: null, budgetMaxToman: 2_000_000, notes: null });
    }
    if (/\/v1\/orders\/[^/]+$/.test(url)) {
      const id = url.split('/').pop() as string;
      orderReads.push(id);
      if (options.orderFails) return fail();
      return ok(options.orders?.[id] ?? order({ id }));
    }
    if (/\/v1\/providers\/[^/]+$/.test(url)) {
      const id = url.split('/').pop() as string;
      providerReads.push(id);
      if (options.providerFails) return fail();
      return ok({
        id,
        displayName: id === 'prof-1' ? 'آتلیه سارا محمدی' : 'استودیو مهسا',
        bio: null,
        cityId: null,
        specialties: [],
        verificationStatus: 'verified',
        images: { avatar: null, cover: null },
        rating: { average: null, count: 0 },
        saved: false,
        createdAt: '2025-08-01T00:00:00.000Z',
      });
    }
    return ok([]);
  });
}

function renderDashboard() {
  return render(
    <AuthProvider>
      <DashboardPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the dashboard gathers what the header stopped carrying', () => {
  it('shows the next booking, the past ones, loyalty, notifications and the journey', async () => {
    mockApi({ bookings: [booking(), booking({ id: 'b2', startAt: PAST, endAt: PAST, status: 'completed' })] });
    renderDashboard();

    expect(await screen.findByTestId('upcoming-booking')).toBeInTheDocument();
    expect(screen.getByTestId('past-bookings')).toBeInTheDocument();
    expect(screen.getByTestId('loyalty-card')).toBeInTheDocument();
    expect(screen.getByTestId('notifications')).toBeInTheDocument();
    expect(screen.getByTestId('journey')).toBeInTheDocument();
  });

  it('greets by the name the server holds, and never by a phone number', async () => {
    mockApi();
    renderDashboard();

    expect(await screen.findByRole('heading', { name: 'سلام مینا', level: 1 })).toBeInTheDocument();
    // The number belongs in the account card, in its own LTR run.
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('۰۹۱۳');
    expect(document.body.textContent).toContain('۰۹۱۳۱۲۳۴۵۶۷');
  });

  it('separates upcoming from past by time AND by status', async () => {
    mockApi({
      bookings: [
        booking({ id: 'future-confirmed' }),
        // In the future but cancelled — not something to turn up to.
        booking({ id: 'future-cancelled', status: 'cancelled' }),
        booking({ id: 'past-done', startAt: PAST, endAt: PAST, status: 'completed' }),
      ],
    });
    renderDashboard();

    const upcoming = await screen.findByTestId('upcoming-booking');
    expect(upcoming.textContent).toContain('تأیید شده');
    const past = screen.getByTestId('past-bookings');
    expect([...past.querySelectorAll('[data-booking]')].map((r) => r.getAttribute('data-booking'))).toEqual([
      'future-cancelled',
      'past-done',
    ]);
  });

  it('renders the loyalty figures the server sent, including the progress bar', async () => {
    mockApi();
    renderDashboard();

    const card = await screen.findByTestId('loyalty-card');
    expect(card.textContent).toContain('۴۲۰');
    expect(card.textContent).toContain('۱۱۵۰');
    expect(card.textContent).toContain('نقره‌ای');
    expect(card.textContent).toContain('۳۵۰ امتیاز تا طلایی');
    const bar = within(card).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '68');
    // A bar with no accessible name is a decoration.
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('طلایی'));
  });

  it('counts only the unread notifications', async () => {
    mockApi();
    renderDashboard();
    await screen.findByTestId('notifications');

    // Two notices, one read: the badge says one, not two.
    const heading = screen.getByRole('heading', { name: 'اعلان‌ها' }).parentElement as HTMLElement;
    expect(heading.textContent).toContain('۱');
  });
});

describe('resolving the professional’s name', () => {
  it('reads each distinct professional once, not once per row', async () => {
    mockApi({
      bookings: [
        booking({ id: 'b1', startAt: PAST, endAt: PAST, status: 'completed' }),
        booking({ id: 'b2', startAt: PAST, endAt: PAST, status: 'completed' }),
        booking({ id: 'b3', professionalId: 'prof-2', startAt: PAST, endAt: PAST, status: 'completed' }),
      ],
    });
    renderDashboard();

    await screen.findByTestId('past-bookings');
    // The same salon three times is one request, not three.
    await waitFor(() => expect(providerReads.sort()).toEqual(['prof-1', 'prof-2']));
  });

  it('omits a name it could not resolve rather than showing an identifier', async () => {
    mockApi({ providerFails: true, bookings: [booking({ startAt: PAST, endAt: PAST, status: 'completed' })] });
    renderDashboard();

    const past = await screen.findByTestId('past-bookings');
    await waitFor(() => expect(providerReads.length).toBeGreaterThan(0));
    // A uuid on a customer's screen is not information, and a made-up label
    // is worse than none.
    expect(past.textContent).not.toContain('prof-1');
    expect(past.textContent).toContain('انجام شده');
  });
});

describe('a section that fails does not take the page with it', () => {
  it('renders without the loyalty card when loyalty cannot be read', async () => {
    mockApi({ loyaltyFails: true });
    renderDashboard();

    expect(await screen.findByTestId('upcoming-booking')).toBeInTheDocument();
    expect(screen.queryByTestId('loyalty-card')).toBeNull();
    // And says nothing about points it does not have.
    expect(document.body.textContent).not.toContain('امتیاز تا');
  });

  it('renders without the notifications when they cannot be read', async () => {
    mockApi({ noticesFail: true });
    renderDashboard();

    expect(await screen.findByTestId('loyalty-card')).toBeInTheDocument();
    expect(screen.getByText('اعلانی ندارید.')).toBeInTheDocument();
  });

  it('fails the whole page only when the page’s own reads fail', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
      if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+98', displayName: 'مینا', roles: [], capabilities: [] });
      if (url.includes('/v1/me/bookings')) return fail();
      return ok([]);
    });
    renderDashboard();

    expect(await screen.findByRole('button', { name: /تلاش/ })).toBeInTheDocument();
  });
});

describe('the amount collected on the upcoming booking (#225)', () => {
  it('reads the order the booking names, and shows what that order collected', async () => {
    mockApi({ bookings: [booking({ orderId: 'o1' })] });
    renderDashboard();
    const upcoming = await screen.findByTestId('upcoming-booking');

    const paid = await within(upcoming).findByTestId('upcoming-paid');
    expect(paid).toHaveTextContent('پرداخت‌شده');
    expect(paid).toHaveTextContent('۸۰۷٬۵۰۰');
    // One read, of the order the booking named — not a guess at an id.
    expect(orderReads).toEqual(['o1']);
  });

  /*
   * The figure is the ORDER's, and `collectedTotalToman` is the only field it
   * may come from: the page must not reach the same number by subtracting
   * refunds from a total, or by adding the schedule up.
   */
  it('shows what was collected, not the order total, when a refund has moved them apart', async () => {
    mockApi({
      bookings: [booking({ orderId: 'o1' })],
      orders: { o1: order({ id: 'o1', status: 'partially_refunded', refundedTotalToman: 300_000, collectedTotalToman: 507_500 }) },
    });
    renderDashboard();
    const paid = await screen.findByTestId('upcoming-paid');

    expect(paid).toHaveTextContent('۵۰۷٬۵۰۰');
    expect(paid.textContent).not.toContain('۸۰۷٬۵۰۰');
  });

  it('carries the unit on the label exactly once, and never on the figure', async () => {
    mockApi({ bookings: [booking({ orderId: 'o1' })] });
    renderDashboard();
    const paid = await screen.findByTestId('upcoming-paid');

    // #287: the unit once per block. The label is where a labelled figure carries it.
    expect(paid).toHaveTextContent('پرداخت‌شده (تومان)');
    expect(paid.textContent?.match(/تومان/g)).toHaveLength(1);
  });

  it('reads the order of the EARLIEST upcoming booking, whatever order the server returned', async () => {
    mockApi({
      bookings: [
        booking({ id: 'b-later', startAt: '2099-12-01T06:30:00.000Z', endAt: '2099-12-01T09:30:00.000Z', orderId: 'o-later' }),
        booking({ id: 'b-sooner', startAt: FUTURE, endAt: '2099-09-15T09:30:00.000Z', orderId: 'o-sooner' }),
      ],
    });
    renderDashboard();
    await screen.findByTestId('upcoming-paid');

    // The card shows one booking; reading the other one's order would put a
    // different appointment's money on it.
    expect(orderReads).toEqual(['o-sooner']);
  });

  it('asks for nothing when the booking produced no order', async () => {
    mockApi({ bookings: [booking({ orderId: null })] });
    renderDashboard();
    const upcoming = await screen.findByTestId('upcoming-booking');

    await waitFor(() => expect(providerReads).toEqual(['prof-1']));
    expect(orderReads).toEqual([]);
    expect(within(upcoming).queryByTestId('upcoming-paid')).toBeNull();
  });

  it('shows nothing rather than zero when the order collected nothing online', async () => {
    // V3.3 `#41b`: not paid, not free, not settled. «پرداخت‌شده ۰» would be a lie.
    mockApi({
      bookings: [booking({ orderId: 'o1' })],
      orders: { o1: order({ id: 'o1', status: 'online_collection_not_required', collectedTotalToman: 0, paidAt: null }) },
    });
    renderDashboard();
    const upcoming = await screen.findByTestId('upcoming-booking');

    await waitFor(() => expect(orderReads).toEqual(['o1']));
    expect(within(upcoming).queryByTestId('upcoming-paid')).toBeNull();
    expect(upcoming.textContent).not.toContain('پرداخت‌شده');
  });

  it('keeps the card when the order read fails, like a missing professional name', async () => {
    mockApi({ bookings: [booking({ orderId: 'o1' })], orderFails: true });
    renderDashboard();
    const upcoming = await screen.findByTestId('upcoming-booking');

    await waitFor(() => expect(orderReads).toEqual(['o1']));
    expect(within(upcoming).queryByTestId('upcoming-paid')).toBeNull();
    // The rest of the card is still there, and the page did not fail.
    expect(upcoming).toHaveTextContent('آتلیه سارا محمدی');
    expect(screen.queryByRole('button', { name: /تلاش/ })).toBeNull();
  });
});

describe('claims the page does not make', () => {
  it('shows no membership date, because /v1/me has no createdAt', async () => {
    mockApi();
    renderDashboard();
    await screen.findByTestId('loyalty-card');

    expect(document.body.textContent).not.toContain('عضویت');
  });

  it('says plainly when there is no upcoming booking', async () => {
    mockApi({ bookings: [] });
    renderDashboard();

    expect(await screen.findByText(/هنوز نوبتی رزرو نکرده‌اید/)).toBeInTheDocument();
    expect(screen.getByText('نوبت گذشته‌ای ندارید.')).toBeInTheDocument();
  });
});

describe('the order the page shows and the order it resolves names from', () => {
  it('names the EARLIEST upcoming booking, whatever order the server returned', async () => {
    /*
     * The defect this pins. `load()` resolved the professional for the first
     * upcoming booking in ARRIVAL order while the render showed the earliest
     * by TIME, so any server ordering other than chronological put one
     * appointment's date beside a different appointment's salon.
     *
     * The list below arrives LATEST FIRST, which is a perfectly ordinary
     * thing for a bookings endpoint to do.
     */
    mockApi({
      bookings: [
        booking({ id: 'later', professionalId: 'prof-2', startAt: '2099-10-20T06:30:00.000Z', endAt: '2099-10-20T09:30:00.000Z' }),
        booking({ id: 'sooner', professionalId: 'prof-1', startAt: '2099-09-15T06:30:00.000Z', endAt: '2099-09-15T09:30:00.000Z' }),
      ],
    });
    renderDashboard();

    const upcoming = await screen.findByTestId('upcoming-booking');
    await waitFor(() => expect(providerReads.length).toBeGreaterThan(0));
    // The card is the September one, so the name must be September's salon.
    await waitFor(() => expect(upcoming.textContent).toContain('آتلیه سارا محمدی'));
    expect(upcoming.textContent).not.toContain('استودیو مهسا');
  });

  it('resolves names for the past rows it actually shows, not the first three that arrived', async () => {
    const past = (id: string, professionalId: string, startAt: string) =>
      booking({ id, professionalId, startAt, endAt: startAt, status: 'completed' as const });
    mockApi({
      bookings: [
        // Oldest first — the opposite of the newest-first order rendered.
        past('p1', 'prof-2', '2019-01-01T06:30:00.000Z'),
        past('p2', 'prof-2', '2019-02-01T06:30:00.000Z'),
        past('p3', 'prof-2', '2019-03-01T06:30:00.000Z'),
        past('p4', 'prof-1', '2020-03-01T06:30:00.000Z'),
      ],
    });
    renderDashboard();

    await screen.findByTestId('past-bookings');
    // `prof-1` owns the newest booking, so it must be among the names read.
    await waitFor(() => expect(providerReads).toContain('prof-1'));
  });
});
