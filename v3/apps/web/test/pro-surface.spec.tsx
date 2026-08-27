import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProProfilePage from '@/app/pro/profile/page';
import ProServicesPage from '@/app/pro/services/page';
import ProAvailabilityPage from '@/app/pro/availability/page';
import ProBookingsPage from '@/app/pro/bookings/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { ConfirmDialog, TextLink } from '@/components/kit';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro',
}));

/**
 * The professional operating surface's state discipline.
 *
 * The cases below are grouped by the question they answer, and the first group
 * is the one that matters most: **can a failed load ever be mistaken for an
 * answer?** Five surfaces got that wrong before v3.0.1, and on this surface the
 * consequence is worse than it was there -- a blank profile editor rendered
 * over a profile that already exists would, on submit, POST a duplicate
 * profile (correctly 409ing) or PATCH blanks over real data.
 */

const PROFILE = {
  id: 'prof-1',
  displayName: 'سالن آزمایشی',
  bio: 'توضیح موجود',
  cityId: 'city-1',
  specialties: [{ id: 'spec-1', name: 'میکاپ' }],
  verificationStatus: 'unverified',
  createdAt: new Date().toISOString(),
};

function authenticate() {
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
}

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function fail() {
  return Promise.reject(new TypeError('Failed to fetch'));
}

/**
 * Routes every request the surface makes. `overrides` is consulted first, so a
 * test names only the endpoint it is actually about.
 */
function mockApi(overrides: Record<string, () => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return handler();
    }
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) return ok(PROFILE);
    if (url.includes('/v1/cities')) return ok([{ id: 'city-1', name: 'یزد' }]);
    if (url.includes('/v1/specialties')) return ok([{ id: 'spec-1', name: 'میکاپ' }]);
    if (url.includes('/services')) return ok([]);
    if (url.includes('/v1/me/availability')) return ok([]);
    if (url.includes('/v1/me/professional-bookings')) return ok([]);
    return ok([]);
  });
}

function renderPro(node: React.ReactElement) {
  return render(
    <AuthProvider>
      <ProProvider>{node}</ProProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  authenticate();
});

// ---------------------------------------------------------------------------

describe('professional profile — a failed load must never become an editable blank form', () => {
  it('shows the failure and a retry, and renders NO form at all', async () => {
    mockApi({ '/v1/me/provider': fail });
    renderPro(<ProProfilePage />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // The regression this test exists for: an editable field here would be a
    // field whose submission overwrites data we could not read.
    expect(screen.queryByLabelText('نام نمایشی')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ساخت پروفایل' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ذخیره تغییرات' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });

  it('retry re-issues the profile request rather than being decorative', async () => {
    mockApi({ '/v1/me/provider': fail });
    const user = userEvent.setup();
    renderPro(<ProProfilePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());
    const before = (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/v1/me/provider')).length;

    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => {
      const after = (global.fetch as jest.Mock).mock.calls.filter((c) =>
        String(c[0]).includes('/v1/me/provider'),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('renders the CREATE form only when the server ANSWERED that no profile exists', async () => {
    mockApi({ '/v1/me/provider': () => ok(null) });
    renderPro(<ProProfilePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'ساخت پروفایل' })).toBeInTheDocument());
    expect(screen.getByLabelText('نام نمایشی')).toHaveValue('');
  });

  it('seeds the edit form from the real profile, never from blanks', async () => {
    mockApi();
    renderPro(<ProProfilePage />);

    await waitFor(() => expect(screen.getByLabelText('نام نمایشی')).toHaveValue('سالن آزمایشی'));
    expect(screen.getByLabelText('درباره من')).toHaveValue('توضیح موجود');
    expect(screen.getByRole('button', { name: 'ذخیره تغییرات' })).toBeInTheDocument();
  });

  it('does not offer a picker full of nothing when reference data fails', async () => {
    mockApi({ '/v1/cities': fail, '/v1/specialties': fail });
    renderPro(<ProProfilePage />);

    await waitFor(() => expect(screen.getByLabelText('نام نمایشی')).toBeInTheDocument());

    // An empty <select> would read as "there are no cities", which is the same
    // false assertion one layer down. It is disabled and says why instead.
    expect(screen.getByLabelText('شهر')).toBeDisabled();
    expect(screen.getByText('در حال بارگذاری فهرست شهرها…')).toBeInTheDocument();
  });
});

describe('the guard in front of every other professional screen', () => {
  it('shows an error with retry — and NOT an invitation to create a profile — when the load failed', async () => {
    mockApi({ '/v1/me/provider': fail });
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByText(/هنوز پروفایل متخصص نساخته‌اید/)).not.toBeInTheDocument();
  });

  it('invites profile creation only when the server answered that there is none', async () => {
    mockApi({ '/v1/me/provider': () => ok(null) });
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByText(/هنوز پروفایل متخصص نساخته‌اید/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('services', () => {
  it('claims "no services yet" only after a successful, genuinely empty response', async () => {
    mockApi({ '/services': () => ok([]) });
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByText(/هنوز هیچ خدمتی ثبت نکرده‌اید/)).toBeInTheDocument());
  });

  it('never claims "no services yet" when the request failed', async () => {
    mockApi({ '/services': fail });
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/هنوز هیچ خدمتی ثبت نکرده‌اید/)).not.toBeInTheDocument();
  });

  it('sends ASCII numbers even when the professional types Persian digits', async () => {
    mockApi({ '/services': () => ok([]) });
    const user = userEvent.setup();
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByLabelText('نام خدمت')).toBeInTheDocument());

    await user.type(screen.getByLabelText('نام خدمت'), 'کوتاهی مو');
    await user.type(screen.getByLabelText('مدت (دقیقه)'), '۶۰');
    await user.type(screen.getByLabelText('قیمت (تومان)'), '۲۵۰۰۰۰');
    await user.click(screen.getByRole('button', { name: 'افزودن خدمت' }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find(
        (c) => String(c[0]).includes('/services') && c[1]?.method === 'POST',
      );
      expect(post).toBeDefined();
      // `Number('۶۰')` is NaN and the DTO would reject it -- the same
      // class of failure QA-01/02 fixed at the auth gate.
      expect(JSON.parse(post![1].body)).toEqual({
        name: 'کوتاهی مو',
        durationMinutes: 60,
        priceToman: 250000,
      });
    });
  });

  it('confirms before deleting rather than destroying on a single click', async () => {
    mockApi({
      '/services': () => ok([{ id: 's1', professionalId: 'prof-1', name: 'کوتاهی', durationMinutes: 60, priceToman: 200000 }]),
    });
    const user = userEvent.setup();
    renderPro(<ProServicesPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'حذف' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'حذف' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/از فهرست خدمات شما حذف می‌شود/)).toBeInTheDocument();

    // Nothing has been sent yet.
    expect(
      (global.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method === 'DELETE'),
    ).toHaveLength(0);
  });
});

describe('availability', () => {
  it('renders slot times in the PLATFORM timezone, not the test machine’s', async () => {
    // 06:30 UTC is exactly 10:00 in Asia/Tehran (+03:30, no DST since 2022).
    // If this screen used `Date#getHours()` the assertion would depend on
    // wherever the test runner's clock is set, which is the whole point.
    const slot = {
      id: 'slot-1',
      professionalId: 'prof-1',
      serviceId: null,
      startAt: '2026-09-15T06:30:00.000Z',
      endAt: '2026-09-15T07:30:00.000Z',
      status: 'open',
    };
    mockApi({ '/v1/me/availability': () => ok([slot]) });
    renderPro(<ProAvailabilityPage />);

    await waitFor(() => expect(screen.getByText(/۱۰:۳۰ تا ۱۱:۰۰|۱۰:۰۰ تا ۱۱:۰۰/)).toBeInTheDocument());
  });

  it('offers no delete control for a BOOKED slot, and says why', async () => {
    const slot = {
      id: 'slot-2',
      professionalId: 'prof-1',
      serviceId: null,
      startAt: '2026-09-15T06:30:00.000Z',
      endAt: '2026-09-15T07:30:00.000Z',
      status: 'booked',
    };
    mockApi({ '/v1/me/availability': () => ok([slot]) });
    renderPro(<ProAvailabilityPage />);

    await waitFor(() => expect(screen.getByText('رزرو شده')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'حذف' })).not.toBeInTheDocument();
    expect(screen.getByText('برای آزاد کردن، رزرو را لغو کنید')).toBeInTheDocument();
  });

  it('never claims "no availability yet" after a failed load', async () => {
    mockApi({ '/v1/me/availability': fail });
    renderPro(<ProAvailabilityPage />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/هنوز هیچ زمان آزادی ثبت نکرده‌اید/)).not.toBeInTheDocument();
  });
});

describe('bookings', () => {
  const confirmedFuture = {
    id: 'bk-1',
    customerId: 'cust-abcdef12',
    professionalId: 'prof-1',
    serviceId: null,
    slotId: 'slot-1',
    startAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    endAt: new Date(Date.now() + 49 * 3_600_000).toISOString(),
    status: 'confirmed',
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
  };

  it('does not offer "no-show" before the slot has ended, and explains the rule', async () => {
    mockApi({ '/v1/me/professional-bookings': () => ok([confirmedFuture]) });
    renderPro(<ProBookingsPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'ثبت انجام نوبت' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'عدم حضور مشتری' })).not.toBeInTheDocument();
    expect(screen.getByText('ثبت عدم حضور تنها پس از پایان زمان نوبت ممکن است.')).toBeInTheDocument();
  });

  it('offers "no-show" once the slot has ended', async () => {
    const ended = {
      ...confirmedFuture,
      startAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      endAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    mockApi({ '/v1/me/professional-bookings': () => ok([ended]) });
    const user = userEvent.setup();
    renderPro(<ProBookingsPage />);

    await user.click(await screen.findByRole('tab', { name: /گذشته/ }));
    expect(await screen.findByRole('button', { name: 'عدم حضور مشتری' })).toBeInTheDocument();
  });

  it('confirms completion before sending it, naming the downstream consequences', async () => {
    mockApi({ '/v1/me/professional-bookings': () => ok([confirmedFuture]) });
    const user = userEvent.setup();
    renderPro(<ProBookingsPage />);

    await user.click(await screen.findByRole('button', { name: 'ثبت انجام نوبت' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/امتیاز باشگاه مشتری/)).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/complete')),
    ).toHaveLength(0);
  });

  it('paints from the SERVER’s returned state, never optimistically', async () => {
    mockApi({
      '/v1/me/professional-bookings': () => ok([confirmedFuture]),
      // The server disagrees with the optimistic outcome: it reports the
      // booking as cancelled, because the customer cancelled a moment ago.
      '/complete': () => ok({ ...confirmedFuture, status: 'cancelled' }),
    });
    const user = userEvent.setup();
    renderPro(<ProBookingsPage />);

    await user.click(await screen.findByRole('button', { name: 'ثبت انجام نوبت' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'بله، انجام شد' }));

    // Two things are asserted, and the second is the point.
    //
    // (1) The card is now labelled with the SERVER's status. An optimistic
    //     update would have painted "انجام شد" -- a claim the server never made.
    // (2) It has moved to the "گذشته" tab, because a cancelled booking is
    //     terminal. That the tabs re-partition off the server's own state,
    //     rather than off what the user just clicked, is the same property
    //     seen from the other side.
    await waitFor(() => expect(screen.getByRole('tab', { name: /گذشته \(۱\)/ })).toBeInTheDocument());
    expect(screen.queryByText('انجام شد')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /گذشته/ }));
    expect(await screen.findByText('لغو شده')).toBeInTheDocument();
  });

  it('never claims "no bookings" after a failed load', async () => {
    mockApi({ '/v1/me/professional-bookings': fail });
    renderPro(<ProBookingsPage />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/رزرو پیش‌رویی ندارید/)).not.toBeInTheDocument();
  });
});

describe('UI primitives', () => {
  it('TextLink carries the 44px touch baseline a bare <Link> never did', () => {
    render(<TextLink href="/pro">برو</TextLink>);
    const link = screen.getByRole('link', { name: 'برو' });
    // The recurring bug class: 44px lives inside `Button` and nothing enforced
    // it for links, so five separate surfaces each re-learned it.
    expect(link).toHaveStyle({ minHeight: '44px' });
  });

  it('ConfirmDialog is a real modal: labelled, focus moved in, Escape closes', async () => {
    const onCancel = jest.fn();
    const user = userEvent.setup();

    render(
      <ConfirmDialog
        open
        title="حذف خدمت"
        body={<p>مطمئن هستید؟</p>}
        confirmLabel="حذف کن"
        onConfirm={jest.fn()}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('حذف خدمت');

    // Focus is INSIDE the dialog, not left on the page behind it.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('ConfirmDialog traps Tab inside itself', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">بیرون از دیالوگ</button>
        <ConfirmDialog
          open
          title="تأیید"
          body={<p>متن</p>}
          confirmLabel="تأیید"
          onConfirm={jest.fn()}
          onCancel={jest.fn()}
        />
      </>,
    );

    const dialog = screen.getByRole('dialog');
    // Tab through more controls than the dialog contains; focus must never
    // escape to the button behind it.
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('renders nothing at all when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="تأیید"
        body={<p>متن</p>}
        confirmLabel="تأیید"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
