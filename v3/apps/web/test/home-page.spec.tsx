import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HomePage from '@/app/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push }),
  usePathname: () => '/',
}));

/**
 * The landing page — `Prototype - Customer.dc.html` §01.
 *
 * ## What these cases are about
 *
 * The page's whole risk is invented data. It is the product's front door, it
 * is the most tempting place to write a confident number, and the design's
 * own data note draws the line: the specialty count and the professionals
 * are real, the per-specialty starting price and the district are not, and
 * no platform statistic exists at all.
 *
 * So most of what is asserted below is the ABSENCE of a claim: no price on a
 * specialty card, no district under a name, no figure when the server sent
 * none, and no locality badge when the platform is not one city.
 *
 * The rest is the four states every list owes the reader — loading, empty,
 * failed, populated — because an empty section under a heading is itself a
 * claim, and a failed read rendered as an empty one is a false one.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    displayName: 'آتلیه سارا محمدی',
    bio: null,
    city: { id: 'c1', name: 'یزد' },
    specialties: ['میکاپ عروس', 'شینیون'],
    isVerified: true,
    services: [],
    priceFromToman: 850_000,
    rating: { average: 0, count: 0 },
    badges: ['verified'],
    ...overrides,
  };
}

function facets(overrides: Record<string, unknown> = {}) {
  return {
    cities: [{ key: 'c1', label: 'یزد', count: 12 }],
    specialties: [
      { key: 'specialty-makeup', label: 'میکاپ عروس', count: 9 },
      { key: 'specialty-hair', label: 'شینیون', count: 14 },
      { key: 'specialty-color', label: 'رنگ و لایت', count: 7 },
      { key: 'specialty-brows', label: 'اصلاح ابرو', count: 21 },
      { key: 'specialty-keratin', label: 'کراتین', count: 2 },
    ],
    verification: [],
    priceRanges: [],
    ...overrides,
  };
}

function searchResponse(overrides: Record<string, unknown> = {}) {
  return {
    items: [provider()],
    pagination: { page: 1, pageSize: 20, total: 1, totalIsApproximate: false, totalPages: 1 },
    facets: facets(),
    degraded: false,
    ...overrides,
  };
}

/**
 * The page makes two search reads: one unfiltered for the facets, one with
 * `verifiedOnly` for the cards. They are distinguished by that parameter.
 */
function mockApi(options: { all?: unknown; verified?: unknown; fail?: boolean } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/search/providers')) {
      if (options.fail) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }),
        });
      }
      const isVerifiedRead = url.includes('verifiedOnly=true');
      const body = isVerifiedRead ? (options.verified ?? searchResponse()) : (options.all ?? searchResponse());
      return ok(body);
    }
    return ok([]);
  });
}

function renderHome() {
  return render(
    <AuthProvider>
      <HomePage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  push.mockClear();
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
});

describe('the landing page — data it has', () => {
  it('renders the four commonest specialties with the server’s own counts', async () => {
    mockApi();
    renderHome();

    const grid = await screen.findByTestId('specialty-grid');
    await waitFor(() => expect(grid.querySelectorAll('[data-specialty]')).toHaveLength(4));

    // Ordered by count, descending — and the fifth specialty is left out
    // rather than squeezed in.
    const names = [...grid.querySelectorAll('[data-specialty]')].map((c) => c.getAttribute('data-specialty'));
    expect(names).toEqual(['specialty-brows', 'specialty-hair', 'specialty-makeup', 'specialty-color']);
    expect(grid.textContent).toContain('۲۱ متخصص');
    expect(grid.textContent).not.toContain('کراتین');
    expect(within(grid).getByRole('link', { name: /میکاپ عروس/ })).toHaveAttribute(
      'href',
      '/search?specialtyIds=specialty-makeup',
    );
  });

  it('renders the verified professionals with the fields the contract carries', async () => {
    mockApi();
    renderHome();

    const list = await screen.findByTestId('verified-providers');
    expect(list.textContent).toContain('آتلیه سارا محمدی');
    expect(list.textContent).toContain('یزد');
    expect(list.textContent).toContain('میکاپ عروس، شینیون');
    expect(list.textContent).toContain('۸۵۰٬۰۰۰');
    expect(within(list).getByText('تأیید شده')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'زمان‌های آزاد' })).toHaveAttribute('href', '/providers/p1');
  });
});

describe('the landing page — claims it does NOT make', () => {
  it('puts no starting price on a specialty card', async () => {
    mockApi();
    renderHome();

    const grid = await screen.findByTestId('specialty-grid');
    await waitFor(() => expect(grid.querySelectorAll('[data-specialty]').length).toBeGreaterThan(0));

    // The design's card reads «از ۸۵۰٬۰۰۰ تومان · ۹ متخصص». The price half
    // would require an additional filtered search per card (or an extended
    // facet). This page makes neither claim implicitly. The count ships and
    // the price does not.
    expect(grid.textContent).not.toContain('تومان');
    expect(grid.textContent).not.toContain('از ۸۵۰');
  });

  it('shows the city and never a district', async () => {
    mockApi();
    renderHome();

    const list = await screen.findByTestId('verified-providers');
    // The design draws «یزد · صفاییه»; the contract carries `city` and
    // nothing finer, and the design itself marks the district as a
    // placeholder for a future field.
    expect(list.textContent).toContain('یزد');
    expect(list.textContent).not.toContain('صفاییه');
    expect(list.textContent).not.toContain('·');
  });

  it('writes no price at all when the server sent none, rather than zero or a dash', async () => {
    mockApi({ verified: searchResponse({ items: [provider({ priceFromToman: null })] }) });
    renderHome();

    const list = await screen.findByTestId('verified-providers');
    expect(list.textContent).toContain('قیمت هنوز اعلام نشده');
    // "شروع از" beside nothing, or beside a dash, both read as a price.
    expect(list.textContent).not.toContain('شروع از');
    expect(list.textContent).not.toMatch(/[۰-۹]/);
  });

  it('drops the locality badge as soon as the platform is more than one city', async () => {
    mockApi({
      all: searchResponse({
        facets: facets({
          cities: [
            { key: 'c1', label: 'یزد', count: 12 },
            { key: 'c2', label: 'اصفهان', count: 3 },
          ],
        }),
      }),
    });
    renderHome();

    await screen.findByTestId('specialty-grid');
    // «یزد و به‌زودی سراسر ایران» is a claim about coverage. It is rendered
    // from the city facet, so it stops being made the moment it stops being
    // true rather than surviving as copy.
    await waitFor(() => expect(screen.queryByText(/به‌زودی سراسر ایران/)).toBeNull());
    expect(screen.getByRole('button', { name: 'جست‌وجو' })).toBeInTheDocument();
  });

  it('carries no platform statistic and no customer testimonial', async () => {
    mockApi();
    renderHome();
    await screen.findByTestId('verified-providers');

    // `platformMetrics` is an admin-only read; "۵۰۰۰ رزرو موفق" on a public
    // page would be a number nobody can check. The review system does not
    // exist at all.
    for (const invented of ['رزرو موفق', 'رضایت', 'امتیاز', 'نظر مشتری']) {
      expect(document.body.textContent).not.toContain(invented);
    }
  });
});

describe('the landing page — its four states', () => {
  it('holds the shape of what is coming with a skeleton, not a spinner', async () => {
    // Both search reads are held: the page issues them with `Promise.all`,
    // so keeping only the last resolver would leave it pending for ever and
    // the case would pass for the wrong reason.
    const held: Array<(value: unknown) => void> = [];
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
      if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+98', displayName: null, roles: [], capabilities: [] });
      if (url.includes('/v1/search/providers')) return new Promise((resolve) => held.push(resolve));
      return ok([]);
    });
    const release = (value: unknown) => held.forEach((resolve) => resolve(value));
    renderHome();

    expect(await screen.findAllByTestId('provider-skeleton')).toHaveLength(3);
    expect(screen.getAllByTestId('specialty-skeleton')).toHaveLength(4);
    // A spinner says "wait"; a skeleton says what is arriving and stops the
    // page jumping when it does.
    expect(screen.queryByText(/در حال بارگذاری/)).toBeNull();

    release({ ok: true, status: 200, json: async () => ({ data: searchResponse(), meta: null, error: null }) });
    await waitFor(() => expect(screen.queryAllByTestId('provider-skeleton')).toHaveLength(0));
  });

  it('says the verified list is empty instead of rendering a heading over nothing', async () => {
    mockApi({ verified: searchResponse({ items: [] }) });
    renderHome();

    expect(await screen.findByText('هنوز متخصص تأییدشده‌ای در دسترس نیست.')).toBeInTheDocument();
  });

  it('never renders a failed read as an empty page, and offers a retry', async () => {
    mockApi({ fail: true });
    renderHome();

    const retry = await screen.findByRole('button', { name: /تلاش/ });
    expect(screen.queryByTestId('specialty-grid')).toBeNull();
    expect(screen.queryByTestId('verified-providers')).toBeNull();
    // "Nothing here" and "we could not find out" are different statements.
    expect(document.body.textContent).not.toContain('هنوز متخصص تأییدشده‌ای');

    mockApi();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('verified-providers')).toBeInTheDocument());
  });
});

describe('the landing page — where it sends people', () => {
  it('takes the hero term to the search page as a query', async () => {
    mockApi();
    renderHome();
    await screen.findByTestId('verified-providers');

    await userEvent.type(screen.getByLabelText('جست‌وجوی خدمت'), 'میکاپ عروس');
    await userEvent.click(screen.getByRole('button', { name: /جست‌وجو/ }));

    expect(push).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('میکاپ عروس')}`);
  });

  it('sends an empty hero field to the unfiltered search rather than to an empty query', async () => {
    mockApi();
    renderHome();
    await screen.findByTestId('verified-providers');

    await userEvent.click(screen.getByRole('button', { name: /جست‌وجو/ }));
    expect(push).toHaveBeenCalledWith('/search');
  });

  it('makes every specialty shortcut a real search for that specialty', async () => {
    mockApi();
    renderHome();

    const row = await screen.findByTestId('popular-specialties');
    const first = within(row).getByRole('link', { name: 'اصلاح ابرو' });
    expect(first).toHaveAttribute('href', '/search?specialtyIds=specialty-brows');

    // Labelled for what the data is. No search-volume figure exists anywhere
    // in the product, so «پرجست‌وجوترین» would be unsupported.
    expect(row.textContent).toContain('تخصص‌های پرتکرار');
    expect(row.textContent).not.toContain('پرجست‌وجو');
  });
});
