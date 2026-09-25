import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchPage from '@/app/search/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/search',
  useSearchParams: () => searchParams,
}));

/**
 * Search results — `Prototype - Customer.dc.html` §03/§04 and
 * `docs/design/screens/01_SEARCH.md`.
 *
 * ## The property this screen exists to fix
 *
 * Seven identical pills in one row: three were a multi-select filter, four
 * were a one-of-many sort, and nothing about them said which was which. The
 * design calls the separation necessary, so most of what is asserted here is
 * that the two are now DIFFERENT KINDS of control — a checkbox group and a
 * `<select>` — not merely two groups of pills.
 *
 * ## And the ARIA repair the spec makes a prerequisite
 *
 * The suggestion list had a `<button>` inside each `role="option"`, which
 * makes the option's accessible name the button's and leaves the listbox
 * unusable from the keyboard. Both halves are asserted: the violation is
 * gone, and arrow keys, Enter and Escape now do what a listbox promises.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    displayName: 'آتلیه سارا محمدی',
    bio: 'میکاپ عروس و مجلسی، با ده سال سابقه در یزد.',
    city: { id: 'c1', name: 'یزد' },
    specialties: ['میکاپ عروس', 'شینیون'],
    isVerified: true,
    services: [],
    priceFromToman: 850_000,
    rating: { average: 0, count: 0 },
    badges: ['verified'],
    saved: false,
    // What the server sends for a professional with nothing uploaded (#226).
    images: { avatar: null, cover: null },
    portfolioCount: 0,
    ...overrides,
  };
}

/** A public descriptor exactly as `GET /v1/providers/:id` gives one under `images`. */
function picture(id: string, width = 512, height = 512) {
  return { id, url: `https://cdn.example/media/${id}.png`, contentType: 'image/png', width, height };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    items: [provider()],
    pagination: { page: 1, pageSize: 20, total: 1, totalIsApproximate: false, totalPages: 1 },
    facets: {
      cities: [{ key: 'c1', label: 'یزد', count: 3 }],
      specialties: [{ key: 'specialty-makeup', label: 'میکاپ عروس', count: 2 }],
      verification: [{ key: 'verified', label: null, count: 2 }],
      priceRanges: [
        { key: 'under_500k', label: null, count: 0 },
        { key: '500k_1m', label: null, count: 1 },
        { key: '1m_2m', label: null, count: 2 },
        { key: 'over_2m', label: null, count: 1 },
      ],
    },
    degraded: false,
    ...overrides,
  };
}

/** Every search URL the page requested, in order. */
let searched: string[];
/** Every mutating wishlist request. */
let mutations: Array<{ method: string; url: string }>;

function mockApi(
  options: {
    body?: unknown;
    fail?: boolean;
    suggestions?: string[];
    saveFails?: boolean;
    /** A refused save with the server's own status, code and Persian message. */
    saveRefusal?: { status: number; code: string; message: string };
  } = {},
) {
  searched = [];
  mutations = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/wishlist/items')) {
      mutations.push({ method, url });
      if (options.saveRefusal) {
        const { status, code, message } = options.saveRefusal;
        return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
      }
      if (options.saveFails) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }),
        });
      }
      return method === 'DELETE' ? ok(null) : ok({ id: 'w1' });
    }
    if (url.includes('/v1/search/autocomplete')) {
      return ok({ suggestions: (options.suggestions ?? []).map((text) => ({ text, kind: 'service', professionalId: null })) });
    }
    if (url.includes('/v1/search/providers')) {
      searched.push(url);
      if (options.fail) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'جست‌وجو انجام نشد.' } }),
        });
      }
      return ok(options.body ?? response());
    }
    return ok([]);
  });
}

function renderSearch() {
  return render(
    <AuthProvider>
      <SearchPage />
    </AuthProvider>,
  );
}

/** The last search request the page issued, as a parsed query. */
function lastQuery(): URLSearchParams {
  return new URLSearchParams(searched[searched.length - 1]?.split('?')[1] ?? '');
}

beforeEach(() => {
  searchParams = new URLSearchParams();
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('filter and order are different kinds of control', () => {
  it('puts the filters in a labelled panel of real checkboxes and radios', async () => {
    mockApi();
    renderSearch();

    const panel = await screen.findByTestId('filter-panel');
    // A checkbox, because verification is genuinely on or off.
    expect(within(panel).getByRole('checkbox', { name: /فقط متخصص‌های تأییدشده/ })).toBeInTheDocument();
    // Radios, because the server filters a price RANGE and not a set of
    // bands: checkboxes would be a control that lies about what it does.
    expect(within(panel).getAllByRole('radio').length).toBe(5);
    expect(within(panel).getByRole('radio', { name: /همه/ })).toBeChecked();
  });

  it('puts order in a select, not in the filter panel', async () => {
    mockApi();
    renderSearch();
    await screen.findByTestId('filter-panel');

    const sort = screen.getByRole('combobox', { name: 'ترتیب نتایج' });
    expect(sort.tagName).toBe('SELECT');
    // The four orders are options of one control, so exactly one can hold.
    expect(within(sort).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'مرتبط‌ترین',
      'برترین‌ها',
      'ارزان‌ترین',
      'گران‌ترین',
    ]);
    expect(within(screen.getByTestId('filter-panel')).queryByText('ارزان‌ترین')).toBeNull();
  });

  it('sends the server the range a chosen band means, and clears it again', async () => {
    mockApi();
    renderSearch();
    const panel = await screen.findByTestId('filter-panel');

    await userEvent.click(within(panel).getByRole('radio', { name: /۱ تا ۲ میلیون/ }));
    await waitFor(() => expect(lastQuery().get('minPrice')).toBe('1000000'));
    expect(lastQuery().get('maxPrice')).toBe('2000000');

    await userEvent.click(within(panel).getByRole('radio', { name: /همه/ }));
    await waitFor(() => expect(lastQuery().has('minPrice')).toBe(false));
    expect(lastQuery().has('maxPrice')).toBe(false);
  });

  it('sends specialty facet keys as the ids accepted by the server filter', async () => {
    mockApi();
    renderSearch();
    const panel = await screen.findByTestId('filter-panel');

    const specialty = await within(panel).findByRole('checkbox', { name: /میکاپ عروس/ });
    await userEvent.click(specialty);
    await waitFor(() => expect(lastQuery().getAll('specialtyIds')).toEqual(['specialty-makeup']));
    expect(specialty).toBeChecked();

    await userEvent.click(specialty);
    await waitFor(() => expect(lastQuery().has('specialtyIds')).toBe(false));
  });

  it('shows each band’s real count and dims a band nothing falls into', async () => {
    mockApi();
    renderSearch();
    const panel = await screen.findByTestId('filter-panel');

    const empty = panel.querySelector('[data-band="under_500k"]') as HTMLElement;
    expect(empty.textContent).toContain('۰');
    // Dimmed and still operable: removing it would change the panel's shape
    // as the reader narrows, and disabling it would hide that the count is
    // zero rather than unknown.
    expect(empty.className).toMatch(/optionEmpty/);
    expect(within(empty).getByRole('radio')).toBeEnabled();
  });

  it('lists the active filters as removable chips', async () => {
    mockApi();
    renderSearch();
    const panel = await screen.findByTestId('filter-panel');

    await userEvent.click(within(panel).getByRole('checkbox', { name: /فقط متخصص‌های تأییدشده/ }));
    await waitFor(() => expect(lastQuery().get('verifiedOnly')).toBe('true'));

    const chips = screen.getByTestId('active-filters');
    await userEvent.click(within(chips).getByRole('button', { name: /حذف فیلتر/ }));
    await waitFor(() => expect(lastQuery().has('verifiedOnly')).toBe(false));
  });
});

/**
 * Scoped to the suggestion list on purpose: the ORDER control is a native
 * `<select>`, and its `<option>` elements carry the same role. An unscoped
 * `getAllByRole('option')` would match both and quietly pass on the wrong
 * elements — which is how the separation these cases are about would be
 * asserted away.
 */
function suggestionList(): HTMLElement {
  return screen.getByRole('listbox', { name: 'پیشنهادها' });
}

async function openSuggestions(term: string) {
  await userEvent.type(screen.getByRole('combobox', { name: /نام متخصص/ }), term);
  await screen.findByRole('listbox', { name: 'پیشنهادها' });
  return within(suggestionList()).getAllByRole('option');
}

describe('the suggestion listbox', () => {
  it('has no button inside an option, which is the violation the spec names', async () => {
    mockApi({ suggestions: ['میکاپ عروس', 'میکاپ مجلسی'] });
    renderSearch();

    const options = await openSuggestions('میکاپ');
    expect(options).toHaveLength(2);
    for (const option of options) {
      // A button inside an option takes over the option's accessible name
      // and leaves the listbox inoperable as a listbox.
      expect(option.querySelector('button')).toBeNull();
      expect(option.textContent?.trim()).not.toBe('');
    }
  });

  it('moves with the arrow keys, takes one with Enter, and dismisses with Escape', async () => {
    mockApi({ suggestions: ['میکاپ عروس', 'میکاپ مجلسی'] });
    renderSearch();

    const field = screen.getByRole('combobox', { name: /نام متخصص/ });
    await openSuggestions('میکاپ');

    await userEvent.keyboard('{ArrowDown}');
    // The highlight is published, or a screen reader cannot follow it.
    await waitFor(() => expect(field).toHaveAttribute('aria-activedescendant'));
    expect(within(suggestionList()).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowDown}');
    expect(within(suggestionList()).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(lastQuery().get('q')).toBe('میکاپ مجلسی'));
    expect(screen.queryByRole('listbox', { name: 'پیشنهادها' })).toBeNull();
  });

  it('Escape closes the list and keeps what was typed', async () => {
    mockApi({ suggestions: ['میکاپ عروس'] });
    renderSearch();

    const field = screen.getByRole('combobox', { name: /نام متخصص/ });
    await openSuggestions('میکاپ');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'پیشنهادها' })).toBeNull());
    expect(field).toHaveValue('میکاپ');
  });
});

describe('the result card', () => {
  it('seeds itself from the URL the home page navigates with', async () => {
    searchParams = new URLSearchParams({ q: 'میکاپ عروس' });
    mockApi();
    renderSearch();

    await waitFor(() => expect(searched.length).toBeGreaterThan(0));
    expect(lastQuery().get('q')).toBe('میکاپ عروس');
    expect(screen.getByRole('combobox', { name: /نام متخصص/ })).toHaveValue('میکاپ عروس');
  });

  it('carries the fields the contract has', async () => {
    mockApi();
    renderSearch();

    const results = await screen.findByTestId('results');
    expect(results.textContent).toContain('آتلیه سارا محمدی');
    expect(results.textContent).toContain('یزد');
    expect(results.textContent).toContain('۸۵۰٬۰۰۰');
    expect(within(results).getByText('تأیید شده')).toBeInTheDocument();
  });

  it('shows no rating at all rather than zero stars', async () => {
    mockApi();
    renderSearch();

    const results = await screen.findByTestId('results');
    // "No reviews yet" and "rated zero" are different statements, and the
    // second one is a slander on a professional nobody has reviewed.
    expect(results.textContent).not.toContain('۰ از');
    expect(results.textContent).not.toContain('★');
    expect(results.textContent).not.toContain('امتیاز');
  });
});

/**
 * #226 — the card's picture and its portfolio count are the professional's own.
 *
 * `01_SEARCH.md`: the avatar in the card's corner, «N نمونه» over it when there
 * is portfolio, and a real no-image state "rather than one identical placeholder
 * for everyone". These cases replace the one that used to assert the count was
 * ABSENT: the server now sends `images` and `portfolioCount`, and every
 * assertion below is about something rendered from them.
 */
describe('the card’s picture and portfolio count (#226)', () => {
  const cardOf = (results: HTMLElement, id: string) => results.querySelector(`[data-provider="${id}"]`) as HTMLElement;

  it('draws the professional’s own avatar, with its size and a name a screen reader can use', async () => {
    mockApi({
      body: response({
        items: [provider({ images: { avatar: picture('a1', 512, 384), cover: null }, portfolioCount: 3 })],
      }),
    });
    renderSearch();

    const results = await screen.findByTestId('results');
    const img = within(cardOf(results, 'p1')).getByRole('img', { name: 'تصویر آتلیه سارا محمدی' });
    expect(img).toHaveAttribute('src', 'https://cdn.example/media/a1.png');
    // The intrinsic size reserves the box before the bytes arrive.
    expect(img).toHaveAttribute('width', '512');
    expect(img).toHaveAttribute('height', '384');
    // Not a fixed tile: it is the picture the server named and no other.
    expect(within(cardOf(results, 'p1')).queryByText('بدون نمونه کار')).toBeNull();
    expect(within(cardOf(results, 'p1')).queryByText('بدون تصویر')).toBeNull();
  });

  it('shows the real portfolio count, in Persian digits, over the picture', async () => {
    mockApi({
      body: response({
        items: [provider({ images: { avatar: picture('a1'), cover: null }, portfolioCount: 12 })],
      }),
    });
    renderSearch();

    const results = await screen.findByTestId('results');
    const badge = within(cardOf(results, 'p1')).getByTestId('portfolio-count');
    expect(within(badge).getByText('۱۲ نمونه')).toBeInTheDocument();
    // A screen reader gets the unabbreviated phrase, once.
    expect(badge).toHaveTextContent('۱۲ نمونه‌کار');
  });

  it('shows a no-image state that says what is missing, and no badge, for a professional with nothing', async () => {
    mockApi(); // default: images all null, portfolioCount 0
    renderSearch();

    const results = await screen.findByTestId('results');
    const card = cardOf(results, 'p1');
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).getByText('بدون نمونه کار')).toBeInTheDocument();
    // Zero is stated by the empty box, never as a «۰ نمونه» badge.
    expect(within(card).queryByTestId('portfolio-count')).toBeNull();
    expect(card.textContent).not.toContain('۰ نمونه');
    // The old identical placeholder tile, with its «نمونه کار» label, is gone.
    expect(within(card).queryByText(/^نمونه کار$/)).toBeNull();
  });

  it('says «بدون تصویر» and still shows the count when there is work but no photo', async () => {
    mockApi({ body: response({ items: [provider({ portfolioCount: 4 })] }) });
    renderSearch();

    const card = cardOf(await screen.findByTestId('results'), 'p1');
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).getByText('بدون تصویر')).toBeInTheDocument();
    expect(within(card).getByText('۴ نمونه')).toBeInTheDocument();
  });

  it('gives each professional their own picture and count, never one for everybody', async () => {
    mockApi({
      body: response({
        items: [
          provider({ id: 'p1', displayName: 'الف', images: { avatar: picture('aaa'), cover: null }, portfolioCount: 2 }),
          provider({ id: 'p2', displayName: 'ب', images: { avatar: picture('bbb'), cover: null }, portfolioCount: 9 }),
          provider({ id: 'p3', displayName: 'ج' }),
        ],
        pagination: { page: 1, pageSize: 20, total: 3, totalIsApproximate: false, totalPages: 1 },
      }),
    });
    renderSearch();

    const results = await screen.findByTestId('results');
    const srcOf = (id: string) => within(cardOf(results, id)).queryByRole('img')?.getAttribute('src') ?? null;
    expect(srcOf('p1')).toBe('https://cdn.example/media/aaa.png');
    expect(srcOf('p2')).toBe('https://cdn.example/media/bbb.png');
    expect(srcOf('p3')).toBeNull();
    expect(within(cardOf(results, 'p1')).getByText('۲ نمونه')).toBeInTheDocument();
    expect(within(cardOf(results, 'p2')).getByText('۹ نمونه')).toBeInTheDocument();
    expect(within(cardOf(results, 'p3')).queryByTestId('portfolio-count')).toBeNull();
  });

  it('falls back to the no-image state when the picture will not load, keeping the count and the link', async () => {
    mockApi({
      body: response({ items: [provider({ images: { avatar: picture('gone'), cover: null }, portfolioCount: 2 })] }),
    });
    renderSearch();

    const results = await screen.findByTestId('results');
    const card = cardOf(results, 'p1');
    fireEvent.error(within(card).getByRole('img'));

    // No broken-image glyph is left behind as the card's only state.
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).getByText('بدون تصویر')).toBeInTheDocument();
    expect(within(card).getByText('۲ نمونه')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'آتلیه سارا محمدی' })).toHaveAttribute('href', '/providers/p1?from=search');
  });

  it('renders a result from a server that has not sent the fields yet as the no-image state', async () => {
    const legacy = provider();
    delete (legacy as Record<string, unknown>).images;
    delete (legacy as Record<string, unknown>).portfolioCount;
    mockApi({ body: response({ items: [legacy] }) });
    renderSearch();

    const card = cardOf(await screen.findByTestId('results'), 'p1');
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).getByText('بدون نمونه کار')).toBeInTheDocument();
  });

  it('draws nothing for an avatar with no loadable url', async () => {
    mockApi({
      body: response({
        items: [provider({ images: { avatar: { id: 'x', url: null, contentType: null, width: null, height: null }, cover: null } })],
      }),
    });
    renderSearch();

    const card = cardOf(await screen.findByTestId('results'), 'p1');
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).getByText('بدون نمونه کار')).toBeInTheDocument();
  });
});

describe('saving a professional', () => {
  it('saves, and patches the one card rather than re-running the search', async () => {
    mockApi();
    renderSearch();
    await screen.findByTestId('results');
    const before = searched.length;

    await userEvent.click(screen.getByRole('button', { name: /افزودن آتلیه سارا محمدی به علاقه‌مندی‌ها/ }));

    await waitFor(() => expect(mutations).toEqual([{ method: 'POST', url: expect.stringContaining('/v1/me/wishlist/items') }]));
    await waitFor(() => expect(screen.getByRole('button', { name: /حذف آتلیه سارا محمدی/ })).toHaveAttribute('aria-pressed', 'true'));
    // A re-read would reorder the list under the reader for a change that
    // affects exactly one card.
    expect(searched.length).toBe(before);
  });

  it('unsaves by the natural key', async () => {
    mockApi({ body: response({ items: [provider({ saved: true })] }) });
    renderSearch();
    await screen.findByTestId('results');

    await userEvent.click(screen.getByRole('button', { name: /حذف آتلیه سارا محمدی/ }));
    await waitFor(() => expect(mutations[0].method).toBe('DELETE'));
    expect(mutations[0].url).toContain('/v1/me/wishlist/items/professional/p1');
  });

  it('tells the customer their list is full, in the server’s own words, and leaves the card unsaved', async () => {
    mockApi({ saveRefusal: {"status":409,"code":"WISHLIST_LIMIT_REACHED","message":"فهرست علاقه‌مندی‌های شما پر است. حداکثر ۵۰۰ مورد می‌توانید ذخیره کنید."} });
    renderSearch();
    await screen.findByTestId('results');

    await userEvent.click(screen.getByRole('button', { name: /افزودن/ }));
    expect(await screen.findByText("فهرست علاقه‌مندی‌های شما پر است. حداکثر ۵۰۰ مورد می‌توانید ذخیره کنید.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /افزودن/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says a target is no longer available without saying why', async () => {
    mockApi({ saveRefusal: { status: 404, code: 'NOT_FOUND_OR_NOT_YOURS', message: 'این مورد یافت نشد.' } });
    renderSearch();
    await screen.findByTestId('results');
    await userEvent.click(screen.getByRole('button', { name: /افزودن/ }));
    expect(await screen.findByText('این مورد دیگر در دسترس نیست.')).toBeInTheDocument();
  });

  it('clears a refusal when the customer tries again', async () => {
    mockApi({ saveRefusal: {"status":409,"code":"WISHLIST_LIMIT_REACHED","message":"فهرست علاقه‌مندی‌های شما پر است. حداکثر ۵۰۰ مورد می‌توانید ذخیره کنید."} });
    renderSearch();
    await screen.findByTestId('results');
    await userEvent.click(screen.getByRole('button', { name: /افزودن/ }));
    await screen.findByText("فهرست علاقه‌مندی‌های شما پر است. حداکثر ۵۰۰ مورد می‌توانید ذخیره کنید.");
    mockApi({ body: response({ items: [provider({ saved: false })] }) });
    await userEvent.click(screen.getByRole('button', { name: /افزودن/ }));
    await waitFor(() => expect(screen.queryByText("فهرست علاقه‌مندی‌های شما پر است. حداکثر ۵۰۰ مورد می‌توانید ذخیره کنید.")).toBeNull());
  });

  it('leaves the control as it was when the save fails', async () => {
    mockApi({ saveFails: true });
    renderSearch();
    await screen.findByTestId('results');

    await userEvent.click(screen.getByRole('button', { name: /افزودن/ }));
    await waitFor(() => expect(mutations.length).toBe(1));
    // A card must never claim a state the server does not hold.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /افزودن/ })).toHaveAttribute('aria-pressed', 'false'),
    );
  });

  it('sends an anonymous visitor to sign in instead of claiming they have not saved it', async () => {
    mockApi({ body: response({ items: [provider({ saved: null })] }) });
    renderSearch();
    const results = await screen.findByTestId('results');

    // `null` is not `false`. It means the server could not identify anyone,
    // so there is no pressed state to render and nothing to toggle.
    expect(within(results).queryByRole('button', { name: /علاقه‌مندی/ })).toBeNull();
    expect(within(results).getByRole('link', { name: /برای ذخیرهٔ آتلیه سارا محمدی وارد شوید/ })).toHaveAttribute(
      'href',
      '/auth',
    );
  });
});

describe('the four states', () => {
  it('holds the shape of the results with skeletons', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
      if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+98', displayName: null, roles: [], capabilities: [] });
      if (url.includes('/v1/search/providers')) return new Promise(() => undefined);
      return ok([]);
    });
    renderSearch();

    expect(await screen.findAllByTestId('result-skeleton')).toHaveLength(3);
  });

  it('gives a failed search a retry, which the old Alert did not have', async () => {
    mockApi({ fail: true });
    renderSearch();

    const retry = await screen.findByRole('button', { name: /تلاش/ });
    // The two statements that must stay apart: "nothing matched" and "we
    // could not find out".
    expect(document.body.textContent).not.toContain('نتیجه‌ای نداشت');

    mockApi();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('results')).toBeInTheDocument());
  });

  it('says nothing matched, and suggests removing a filter', async () => {
    mockApi({ body: response({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalIsApproximate: false, totalPages: 0 } }) });
    renderSearch();

    expect(await screen.findByText(/جست‌وجوی شما نتیجه‌ای نداشت/)).toBeInTheDocument();
    // And it does not announce a count of zero as though it were an answer.
    expect(screen.queryByText(/۰ متخصص یافت شد/)).toBeNull();
  });

  it('labels a degraded result set as narrower, not as a failure', async () => {
    mockApi({ body: response({ degraded: true }) });
    renderSearch();

    const notice = await screen.findByText(/نتایج به‌صورت موقت محدود است/);
    // `info`, not `error`: nothing failed, so nothing should be red.
    expect(notice.closest('[data-bc-alert]')).toHaveAttribute('data-bc-alert', 'info');
  });

  it('keeps stale results visible but labelled when a later search fails', async () => {
    mockApi();
    renderSearch();
    await screen.findByTestId('results');

    mockApi({ fail: true });
    await userEvent.click(screen.getByRole('checkbox', { name: /فقط متخصص‌های تأییدشده/ }));

    await waitFor(() => expect(screen.getByText(/مربوط به جست‌وجوی قبلی/)).toBeInTheDocument());
    // Still on screen — but no longer presented as the answer to what was
    // just asked.
    expect(screen.getByTestId('results').textContent).toContain('آتلیه سارا محمدی');
  });
});
