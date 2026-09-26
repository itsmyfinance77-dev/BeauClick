import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsPage from '@/app/bookings/page';
import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { takePendingConversation } from '@/lib/chat-intent';
import { tokenStorage } from '@/lib/token-storage';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: mockPush }),
  usePathname: () => '/bookings',
}));

/**
 * The customer and business surfaces this phase touched.
 *
 * These screens predate the component kit and the destructive-action contract
 * that `/pro` established, and they had drifted from both. What is asserted
 * here is the drift being closed, not new behaviour: a touch target that meets
 * the project's own baseline, and irreversible actions that ask first.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

const CONFIRMED_BOOKING = {
  id: 'b1',
  customerId: 'u1',
  professionalId: 'prof-1',
  serviceId: 's1',
  slotId: 'slot-1',
  // 06:30 UTC is exactly 10:00 in Asia/Tehran. Named as an absolute instant so
  // the assertion does not depend on the test runner's own clock (R31-09).
  startAt: '2099-09-15T06:30:00.000Z',
  endAt: '2099-09-15T07:30:00.000Z',
  status: 'confirmed' as const,
  holdExpiresAt: null,
  rescheduleCount: 0,
  cancellationReason: null,
  createdAt: '2099-09-01T06:30:00.000Z',
};

/**
 * NOTE the fragment ORDER. Overrides are matched by `includes`, and
 * `/v1/me/business-staff` contains `/v1/me/business` as a substring -- so a
 * memberships request is caught by a `/v1/me/business` override unless the
 * more specific fragment is declared first. Object keys iterate in insertion
 * order, which makes that ordering the caller's to get right.
 */
function mockApi(overrides: Record<string, (init?: RequestInit) => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return handler(init);
    }
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: capabilities });
    }
    if (url.includes('/v1/me/bookings')) return ok([CONFIRMED_BOOKING]);
    if (url.includes('/v1/me/business-staff')) return ok([]);
    if (url.includes('/v1/me/business')) return ok(null);
    return ok([]);
  });
}

let capabilities: string[] = [];

beforeEach(() => {
  capabilities = [];
  mockPush.mockReset();
  takePendingConversation();
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('customer bookings', () => {
  it('renders the appointment time in the PLATFORM timezone, not the runner’s', async () => {
    mockApi();
    render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );
    // Would read ۰۶:۳۰ on a UTC host if `slotTimeLabel` consulted the ambient
    // clock. It reads the platform zone, so this holds everywhere.
    await waitFor(() => expect(screen.getByText('۱۰:۰۰')).toBeInTheDocument());
  });

  it('asks before cancelling, and sends nothing until the customer confirms', async () => {
    mockApi();
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'لغو رزرو' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'لغو رزرو' }));

    // Cancelling is irreversible, releases the slot, and on a paid booking
    // starts a refund. It was a single click.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/برگشت‌پذیر نیست/)).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/cancel')),
    ).toHaveLength(0);
  });

  it('cancels once confirmed', async () => {
    mockApi({ '/cancel': () => ok({ ...CONFIRMED_BOOKING, status: 'cancelled' }) });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'لغو رزرو' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'لغو رزرو' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'بله، لغو کن' }));

    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/cancel')),
      ).toHaveLength(1),
    );
  });

  it('gives the empty state’s only link a real touch target (TOUCH-CLASS, instance six)', async () => {
    mockApi({ '/v1/me/bookings': () => ok([]) });
    render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );

    // Was a bare `<Link style={{ fontWeight: 600 }}>`, roughly 29px tall. Now
    // `TextLink`'s own `kit.module.css` class carries the 44px baseline --
    // jsdom never loads that real stylesheet (CSS modules mock to class
    // names only), so the class itself is what a jsdom test can assert.
    const link = await screen.findByRole('link', { name: 'مشاهده‌ی متخصص‌ها' });
    expect(link).toHaveClass('textLink');
  });
});

describe('customer bookings — upcoming and past', () => {
  const PAST_COMPLETED = {
    ...CONFIRMED_BOOKING,
    id: 'b2',
    startAt: '2020-01-10T06:30:00.000Z',
    endAt: '2020-01-10T07:30:00.000Z',
    status: 'completed' as const,
  };
  // Confirmed but already over: a booking is only "upcoming" while it is ahead.
  const PAST_CONFIRMED = { ...CONFIRMED_BOOKING, id: 'b3', startAt: '2020-02-10T06:30:00.000Z', endAt: '2020-02-10T07:30:00.000Z' };

  function renderBookings() {
    return render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );
  }

  it('opens on the upcoming tab and keeps the past ones off it', async () => {
    mockApi({ '/v1/me/bookings': () => ok([CONFIRMED_BOOKING, PAST_COMPLETED]) });
    renderBookings();
    const list = await screen.findByTestId('bookings-upcoming');
    expect(list.querySelectorAll('[data-booking]')).toHaveLength(1);
    expect(list.querySelector('[data-booking="b1"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'پیش‌رو' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the past tab on request, newest first, with no cancel control on a booking that is over', async () => {
    mockApi({ '/v1/me/bookings': () => ok([PAST_COMPLETED, PAST_CONFIRMED]) });
    const user = userEvent.setup();
    renderBookings();
    // Both are over, so the default tab has nothing to show yet.
    expect(await screen.findByText('نوبت پیش‌رویی ندارید.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'گذشته' }));
    const list = await screen.findByTestId('bookings-past');
    // 2020-02 is more recent than 2020-01.
    expect([...list.querySelectorAll('[data-booking]')].map((li) => li.getAttribute('data-booking'))).toEqual(['b3', 'b2']);
    // A confirmed booking whose time has passed is not cancellable.
    expect(within(list).queryByRole('button', { name: 'لغو رزرو' })).toBeNull();
  });

  it('gives each tab its own empty sentence', async () => {
    mockApi({ '/v1/me/bookings': () => ok([CONFIRMED_BOOKING]) });
    const user = userEvent.setup();
    renderBookings();
    await screen.findByTestId('bookings-upcoming');
    await user.click(screen.getByRole('button', { name: 'گذشته' }));
    expect(await screen.findByText('هنوز نوبتی در گذشته ثبت نشده است.')).toBeInTheDocument();
  });

  it('puts the clock in its own left-to-right run', async () => {
    mockApi();
    renderBookings();
    const clock = await screen.findByText('۱۰:۰۰');
    expect(clock.tagName).toBe('SPAN');
    expect(clock.className).toContain('clock');
  });
});

// #328: a conversation starts from a qualifying booking, and only there.
describe('customer bookings — the message entry', () => {
  const SALON_BOOKING = { ...CONFIRMED_BOOKING, id: 'b9' };
  const PENDING = { ...CONFIRMED_BOOKING, id: 'b8', status: 'pending' as const };

  function renderBookings() {
    return render(
      <AuthProvider>
        <BookingsPage />
      </AuthProvider>,
    );
  }

  const fail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'X', message: 'x' } }) });

  it('is offered only on the bookings the server listed as qualifying', async () => {
    capabilities = ['bc_use_chat'];
    mockApi({
      '/v1/chat/eligible-counterparties': () => ok({ items: [{ counterpartyType: 'business', counterpartyId: 'biz-9', bookingIds: ['b9'] }] }),
      '/v1/me/bookings': () => ok([SALON_BOOKING, PENDING]),
    });
    renderBookings();
    const list = await screen.findByTestId('bookings-upcoming');
    await waitFor(() => expect(within(list.querySelector('[data-booking="b9"]') as HTMLElement).getByRole('button', { name: 'پیام' })).toBeInTheDocument());
    expect(within(list.querySelector('[data-booking="b8"]') as HTMLElement).queryByRole('button', { name: 'پیام' })).toBeNull();
  });

  it('opens the SALON`s conversation for a salon-sold booking — the pair exactly as the server gave it — and goes to the inbox', async () => {
    capabilities = ['bc_use_chat'];
    mockApi({
      '/v1/chat/eligible-counterparties': () => ok({ items: [{ counterpartyType: 'business', counterpartyId: 'biz-9', bookingIds: ['b9'] }] }),
      '/v1/chat/conversations': () => Promise.resolve({ ok: true, status: 201, json: async () => ({ data: { id: 'conv-9' }, meta: null, error: null }) }),
      '/v1/me/bookings': () => ok([SALON_BOOKING]),
    });
    const user = userEvent.setup();
    renderBookings();
    await user.click(await screen.findByRole('button', { name: 'پیام' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/messages'));
    const started = (global.fetch as jest.Mock).mock.calls.find(([url, init]: [string, RequestInit]) => String(url).endsWith('/v1/chat/conversations') && init?.method === 'POST');
    expect(JSON.parse(String(started[1].body))).toEqual({ counterpartyType: 'business', counterpartyId: 'biz-9' });
    // The thread to open travels in memory, never in the URL.
    expect(mockPush.mock.calls[0][0]).toBe('/messages');
    expect(takePendingConversation()).toBe('conv-9');
  });

  it('offers no message entry anywhere when the eligibility read fails, or without bc_use_chat', async () => {
    capabilities = ['bc_use_chat'];
    mockApi({ '/v1/chat/eligible-counterparties': fail, '/v1/me/bookings': () => ok([SALON_BOOKING]) });
    const first = renderBookings();
    await screen.findByTestId('bookings-upcoming');
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('eligible-counterparties'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'پیام' })).toBeNull();
    first.unmount();

    capabilities = [];
    (global.fetch as jest.Mock).mockClear();
    renderBookings();
    await screen.findByTestId('bookings-upcoming');
    expect(screen.queryByRole('button', { name: 'پیام' })).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('/v1/chat/'))).toBe(false);
  });
});

describe('business surface', () => {
  const OWNED = { id: 'biz-1', ownerId: 'u1', displayName: 'سالن', bio: null, cityId: null, verificationStatus: 'unverified', createdAt: '2099-01-01T00:00:00.000Z' };

  // #328: the business inbox entry — the owner (and active managers) only.
  it('links the owner to the business inbox when the session holds bc_use_chat', async () => {
    capabilities = ['bc_use_chat'];
    mockApi({ '/v1/me/business-staff': () => ok([]), '/v1/me/business': () => ok(OWNED), '/businesses/biz-1/staff': () => ok([]) });
    render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );
    expect(await screen.findByRole('link', { name: 'صندوق گفتگو' })).toHaveAttribute('href', '/business/messages');
  });

  it('gives a session with no business of its own no inbox entry at all', async () => {
    capabilities = ['bc_use_chat'];
    mockApi({ '/v1/me/business-staff': () => ok([]), '/v1/me/business': () => ok(null) });
    render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'کسب‌وکار' });
    expect(screen.queryByRole('link', { name: 'صندوق گفتگو' })).toBeNull();
  });

  it('offers the role choice as 44px controls rather than bare radios', async () => {
    mockApi({
      '/v1/me/business-staff': () => ok([]),
      '/v1/me/business': () => ok({ id: 'biz-1', ownerId: 'u1', displayName: 'سالن', bio: null, cityId: null, verificationStatus: 'unverified', createdAt: '2099-01-01T00:00:00.000Z' }),
      '/businesses/biz-1/staff': () => ok([]),
    });
    render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );

    // Two bare radios in labels with no `minHeight` -- the tappable area was
    // the glyph plus a 14px line, well under the project's 44px baseline.
    // `SegmentedControl`'s `.segment` class (`kit.module.css`) carries it now;
    // jsdom never loads that real stylesheet, so the class is what a jsdom
    // test can assert.
    const group = await screen.findByRole('group', { name: 'نقش' });
    for (const option of within(group).getAllByRole('button')) {
      expect(option).toHaveClass('segment');
    }
  });

  it('asks before removing a member, and sends nothing until confirmed', async () => {
    mockApi({
      '/v1/me/business-staff': () => ok([]),
      '/v1/me/business': () => ok({ id: 'biz-1', ownerId: 'u1', displayName: 'سالن', bio: null, cityId: null, verificationStatus: 'unverified', createdAt: '2099-01-01T00:00:00.000Z' }),
      // The more specific fragment MUST be declared first -- `staff-management`
      // contains `staff` as a substring, and `mockApi` matches by `includes` in
      // insertion order (V3.3 Story #149, `#149a`: the owner roster now reads
      // its identity from the sibling staff-management route).
      '/businesses/biz-1/staff-management': () =>
        ok({
          items: [
            {
              id: 'staff-1',
              role: 'staff',
              status: 'active',
              displayLabel: 'شمارهٔ منتهی به 1234',
              labelSource: 'phone',
              identificationHint: '1234',
              roles: [],
            },
          ],
        }),
      '/businesses/biz-1/staff': () => ok([]),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'حذف' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'حذف' }));

    // Removal is irreversible through the product: re-entry needs a fresh
    // invitation from the owner. It was a single click.
    const dialog = await screen.findByRole('dialog', { name: 'حذف عضو' });
    expect(within(dialog).getByText(/باید دوباره دعوت شود/)).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'DELETE'),
    ).toHaveLength(0);
  });

  it('never renders the create-a-business form after a FAILED load', async () => {
    mockApi({ '/v1/me/business': () => Promise.reject(new TypeError('Failed to fetch')) });
    render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );

    // Offering to create a second business to someone who already has one,
    // because the server could not be reached, is the same class of defect as
    // the professional profile's blank-editor case.
    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'ثبت کسب‌وکار' })).not.toBeInTheDocument();
  });
});
