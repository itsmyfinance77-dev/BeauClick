import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProviderBookingPage from '@/app/providers/[id]/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prof-1' }),
  useRouter: () => ({ replace: jest.fn(), push }),
  usePathname: () => '/providers/prof-1',
}));

/**
 * The professional's profile and booking panel —
 * `Prototype - Customer.dc.html` §05 and `02_PROVIDER_PROFILE.md`.
 *
 * ## What is worth pinning here
 *
 * The booking half already worked and its two load-bearing properties are
 * asserted so the redesign cannot have quietly dropped them: the confirm
 * request carries **no price**, and it carries **one idempotency key per
 * attempt**. Those are the difference between a marketplace and a form.
 *
 * The profile half is new, and its risk is the usual one — claiming more
 * than the server said. So: a placeholder only where a picture genuinely
 * does not exist, the city NAME and never its uuid, and no completed-booking
 * count at all, because no route exposes one.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

const PROVIDER = {
  id: 'prof-1',
  displayName: 'آتلیه سارا محمدی',
  bio: 'میکاپ عروس و مجلسی، با ده سال سابقه در یزد.',
  cityId: 'city-yazd',
  specialties: [
    { id: 's1', name: 'میکاپ عروس' },
    { id: 's2', name: 'شینیون' },
  ],
  verificationStatus: 'verified',
  images: { avatar: null, cover: null },
  rating: { average: null, count: 0 },
  saved: false,
  createdAt: '2025-08-01T00:00:00.000Z',
};

const SERVICES = [
  { id: 'svc-1', professionalId: 'prof-1', name: 'میکاپ عروس', durationMinutes: 180, priceToman: 850_000, saved: false },
  { id: 'svc-2', professionalId: 'prof-1', name: 'شینیون', durationMinutes: 90, priceToman: 420_000, saved: true },
];

/** Two days of slots, so the day strip has something to switch between. */
const SLOTS = [
  { id: 'slot-1', serviceId: 'svc-1', startAt: '2099-09-15T06:00:00.000Z', endAt: '2099-09-15T09:00:00.000Z' },
  { id: 'slot-2', serviceId: 'svc-1', startAt: '2099-09-15T09:30:00.000Z', endAt: '2099-09-15T12:30:00.000Z' },
  { id: 'slot-3', serviceId: 'svc-1', startAt: '2099-09-16T06:00:00.000Z', endAt: '2099-09-16T09:00:00.000Z' },
];

let requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>;

function mockApi(options: {
  provider?: Record<string, unknown>;
  services?: unknown[];
  portfolio?: unknown[];
  slots?: unknown[];
  portfolioFails?: boolean;
  citiesFail?: boolean;
} = {}) {
  requests = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      requests.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
    }
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/wishlist/items')) return method === 'DELETE' ? ok(null) : ok({ id: 'w1' });
    if (url.includes('/v1/providers/cities')) {
      if (options.citiesFail) return Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'X', message: 'x' } }) });
      return ok([{ id: 'city-yazd', name: 'یزد' }]);
    }
    if (url.includes('/portfolio')) {
      if (options.portfolioFails) return Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'X', message: 'x' } }) });
      return ok(options.portfolio ?? []);
    }
    if (url.includes('/availability')) return ok(options.slots ?? SLOTS);
    if (url.includes('/services')) return ok(options.services ?? SERVICES);
    if (url.includes('/v1/providers/prof-1')) return ok({ ...PROVIDER, ...options.provider });
    if (url.includes('/v1/bookings')) return ok({ order: { id: 'o1' }, payment: { redirectUrl: null } });
    return ok([]);
  });
}

/**
 * The first mutating request whose URL matches, not `requests[0]`.
 *
 * `/v1/auth/refresh` is itself a POST and lands first, so an index would
 * assert on the session refresh and pass or fail for reasons that have
 * nothing to do with the control under test.
 */
async function sentTo(fragment: string) {
  return waitFor(() => {
    const found = requests.find((r) => r.url.includes(fragment));
    if (!found) throw new Error(`no request to ${fragment} yet`);
    return found;
  });
}

function renderProfile() {
  return render(
    <AuthProvider>
      <ProviderBookingPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  push.mockClear();
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the profile shows what the server said, and no more', () => {
  it('names the city instead of showing its identifier', async () => {
    mockApi();
    renderProfile();

    await screen.findByRole('heading', { name: 'آتلیه سارا محمدی', level: 1 });
    // `ProviderSummary` carries `cityId` only; the name comes from the
    // public city list. A uuid on a customer's screen is not information.
    expect(document.body.textContent).toContain('یزد');
    expect(document.body.textContent).not.toContain('city-yazd');
  });

  it('still renders when the city list cannot be read, without inventing a city', async () => {
    mockApi({ citiesFail: true });
    renderProfile();

    await screen.findByRole('heading', { name: 'آتلیه سارا محمدی', level: 1 });
    // A profile whose city cannot be named is still a usable profile.
    expect(screen.getByTestId('services')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('city-yazd');
  });

  it('shows real portfolio pictures, and a placeholder only where there is none', async () => {
    mockApi({
      portfolio: [
        { id: 'pi1', caption: 'میکاپ عروس', position: 0, media: { id: 'm1', url: 'https://cdn.example/1.jpg', contentType: 'image/jpeg', width: 1200, height: 800 }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    renderProfile();

    const gallery = await screen.findByTestId('gallery');
    const image = within(gallery).getByRole('img', { name: 'میکاپ عروس' });
    expect(image).toHaveAttribute('src', 'https://cdn.example/1.jpg');
    // The two tiles with nothing behind them say so rather than repeating
    // the one picture that exists.
    expect(within(gallery).getAllByText('نمونه کار')).toHaveLength(2);
  });

  it('offers "see all" only when there are more pictures than the tiles show', async () => {
    mockApi({ portfolio: [] });
    renderProfile();
    await screen.findByTestId('gallery');
    expect(screen.queryByRole('button', { name: /دیدن همه/ })).toBeNull();

    const media = (n: number) => ({ id: `m${n}`, url: `https://cdn.example/${n}.jpg`, contentType: 'image/jpeg', width: 10, height: 10 });
    mockApi({ portfolio: [0, 1, 2, 3].map((n) => ({ id: `pi${n}`, caption: null, position: n, media: media(n), createdAt: '2026-01-01T00:00:00.000Z' })) });
    renderProfile();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /دیدن همه ۴ نمونه/ }).length).toBeGreaterThan(0));
  });

  it('renders the page when the portfolio read fails', async () => {
    mockApi({ portfolioFails: true });
    renderProfile();

    const gallery = await screen.findByTestId('gallery');
    expect(gallery.textContent).toContain('نمونه کار');
    expect(screen.getByTestId('services')).toBeInTheDocument();
  });

  it('claims no completed-booking count, because no route exposes one', async () => {
    mockApi();
    renderProfile();
    await screen.findByTestId('services');

    // The design shows «۴۸ نوبت انجام‌شده» twice. It is countable in
    // principle and unreadable in practice, so neither card ships.
    expect(document.body.textContent).not.toContain('نوبت انجام‌شده');
    // What does ship is countable from what is on screen.
    expect(document.body.textContent).toContain('۲ خدمت');
  });

  it('keeps the reviews card as the placeholder the design holds space with', async () => {
    mockApi();
    renderProfile();

    const placeholder = await screen.findByTestId('reviews-placeholder');
    expect(placeholder.textContent).toContain('به‌زودی');
    // And no rating is rendered, because nobody has reviewed: `average` is
    // null, and 0 would be a rating rather than the absence of one.
    expect(document.body.textContent).not.toContain('۰ از ۵');
  });
});

describe('saving the professional and saving a service are different things', () => {
  it('saves the professional by its own target type', async () => {
    mockApi();
    renderProfile();
    await screen.findByTestId('services');

    await userEvent.click(screen.getByRole('button', { name: /افزودن آتلیه سارا محمدی به علاقه‌مندی‌ها/ }));
    expect((await sentTo('/v1/me/wishlist/items')).body).toEqual({ targetType: 'professional', targetId: 'prof-1' });
  });

  it('saves a service by its own target type, leaving the professional alone', async () => {
    mockApi();
    renderProfile();
    const list = await screen.findByTestId('services');

    await userEvent.click(within(list).getByRole('button', { name: /افزودن میکاپ عروس به علاقه‌مندی‌ها/ }));
    expect((await sentTo('/v1/me/wishlist/items')).body).toEqual({ targetType: 'service', targetId: 'svc-1' });

    // The professional's own control is untouched by a service save.
    expect(screen.getByRole('button', { name: /افزودن آتلیه سارا محمدی/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sends an anonymous visitor to sign in rather than claiming an unsaved state', async () => {
    mockApi({
      provider: { saved: null },
      services: SERVICES.map((s) => ({ ...s, saved: null })),
    });
    renderProfile();
    await screen.findByTestId('services');

    expect(screen.getByRole('link', { name: /برای ذخیرهٔ آتلیه سارا محمدی وارد شوید/ })).toHaveAttribute('href', '/auth');
    expect(screen.getByRole('link', { name: /برای ذخیرهٔ میکاپ عروس وارد شوید/ })).toHaveAttribute('href', '/auth');
    expect(screen.queryByRole('button', { name: /علاقه‌مندی/ })).toBeNull();
  });
});

describe('choosing a service and a time', () => {
  it('marks the pre-selected service in text as well as by its border', async () => {
    mockApi();
    renderProfile();
    const list = await screen.findByTestId('services');

    // A choice IS made for the caller so the panel has a price to show, and
    // `V33-DEC-020` forbids making one silently — so it is announced, not
    // signalled by a 2px border alone.
    const chosen = list.querySelector('[data-chosen="true"]') as HTMLElement;
    expect(chosen.getAttribute('data-service')).toBe('svc-1');
    expect(chosen.textContent).toContain('انتخاب شد');
  });

  it('changes the price and re-reads availability when another service is chosen', async () => {
    mockApi();
    renderProfile();
    const list = await screen.findByTestId('services');

    await userEvent.click(within(list).getByRole('button', { name: /^شینیون/ }));
    await waitFor(() => expect(list.querySelector('[data-chosen="true"]')?.getAttribute('data-service')).toBe('svc-2'));
    // A slot published for one service is not offerable for another, so a
    // stale list would offer times that always fail at confirm.
    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('availability?serviceId=svc-2'))).toBe(true),
    );
  });

  it('groups the times by day and switches between days', async () => {
    mockApi();
    renderProfile();

    const strip = await screen.findByTestId('day-strip');
    const days = [...strip.querySelectorAll('[data-day]')];
    expect(days).toHaveLength(2);
    expect(days[0].textContent).toContain('۲ زمان');
    expect(days[1].textContent).toContain('۱ زمان');
    expect(screen.getByTestId('slot-grid').querySelectorAll('[data-slot]')).toHaveLength(2);

    await userEvent.click(days[1] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('slot-grid').querySelectorAll('[data-slot]')).toHaveLength(1));
  });

  it('summarises the chosen time with the server’s own end instant', async () => {
    mockApi();
    renderProfile();
    const grid = await screen.findByTestId('slot-grid');

    await userEvent.click(within(grid).getAllByRole('button')[0]);
    const summary = await screen.findByTestId('booking-summary');
    // 06:00Z is 09:30 in Asia/Tehran and 09:00Z is 12:30 — the END comes
    // from `slot.endAt`, never from adding a duration in the browser.
    expect(summary.textContent).toContain('۰۹:۳۰');
    expect(summary.textContent).toContain('۱۲:۳۰');
  });

  it('offers the waitlist, and only when there is genuinely nothing free', async () => {
    mockApi({ slots: [] });
    renderProfile();

    expect(await screen.findByText(/زمان آزادی برای رزرو وجود ندارد/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'عضویت در لیست انتظار' })).toBeInTheDocument();
    // No confirm control over an empty grid.
    expect(screen.queryByRole('button', { name: 'ادامه به پرداخت' })).toBeNull();
  });
});

describe('the two properties the booking half must not lose', () => {
  it('sends ids and never a price', async () => {
    mockApi();
    renderProfile();
    const grid = await screen.findByTestId('slot-grid');

    await userEvent.click(within(grid).getAllByRole('button')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'ادامه به پرداخت' }));

    const booking = await sentTo('/v1/bookings');
    // The server prices the order from its own catalogue. Anything the
    // browser could put here would be a number the customer controls.
    expect(booking.body).toEqual({ professionalId: 'prof-1', slotId: 'slot-1', serviceId: 'svc-1' });
    expect(JSON.stringify(booking.body)).not.toContain('850000');
    expect(JSON.stringify(booking.body)).not.toMatch(/price|toman/i);
  });

  it('carries one idempotency key, so a double tap cannot claim two slots', async () => {
    mockApi();
    renderProfile();
    const grid = await screen.findByTestId('slot-grid');

    await userEvent.click(within(grid).getAllByRole('button')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'ادامه به پرداخت' }));

    const booking = await sentTo('/v1/bookings');
    expect(booking.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(String(booking.headers['Idempotency-Key']).length).toBeGreaterThan(8);
  });

  it('cannot be confirmed before a time is chosen', async () => {
    mockApi();
    renderProfile();
    await screen.findByTestId('slot-grid');

    expect(screen.getByRole('button', { name: 'ادامه به پرداخت' })).toBeDisabled();
  });
});
