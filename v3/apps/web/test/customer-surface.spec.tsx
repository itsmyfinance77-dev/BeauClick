import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsPage from '@/app/bookings/page';
import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
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
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/bookings')) return ok([CONFIRMED_BOOKING]);
    if (url.includes('/v1/me/business-staff')) return ok([]);
    if (url.includes('/v1/me/business')) return ok(null);
    return ok([]);
  });
}

beforeEach(() => {
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

    // Was a bare `<Link style={{ fontWeight: 600 }}>`, roughly 29px tall.
    const link = await screen.findByRole('link', { name: 'مشاهده‌ی متخصص‌ها' });
    expect(link).toHaveStyle({ minHeight: '44px', display: 'inline-flex' });
  });
});

describe('business surface', () => {
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
    const group = await screen.findByRole('group', { name: 'نقش' });
    for (const option of within(group).getAllByRole('button')) {
      expect(option).toHaveStyle({ minHeight: '44px' });
    }
  });

  it('asks before removing a member, and sends nothing until confirmed', async () => {
    mockApi({
      '/v1/me/business-staff': () => ok([]),
      '/v1/me/business': () => ok({ id: 'biz-1', ownerId: 'u1', displayName: 'سالن', bio: null, cityId: null, verificationStatus: 'unverified', createdAt: '2099-01-01T00:00:00.000Z' }),
      '/businesses/biz-1/staff': () =>
        ok([
          {
            id: 'staff-1',
            businessId: 'biz-1',
            userId: 'u2',
            professionalId: null,
            role: 'staff',
            status: 'active',
            invitedBy: 'u1',
            respondedAt: null,
            createdAt: '2099-01-01T00:00:00.000Z',
          },
        ]),
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
