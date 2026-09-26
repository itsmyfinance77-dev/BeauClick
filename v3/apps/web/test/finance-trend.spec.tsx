import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancePage from '@/app/finance/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/finance',
}));

/**
 * #255 -- the finance page's four-month settlement trend (spec 13).
 *
 * The series comes from its own route, `/settlement-series`, which the server
 * computes over the WHOLE history. These tests pin that the chart is drawn
 * from that route and never from the paged settlement table beside it, that it
 * names Jalali months and the running month as running, and that it is one
 * more independent section: its failure blanks nothing else, and a refusal on
 * it is handled as the loss of the workspace, like every other read.
 */

const REF = 'b'.repeat(43);
const OTHER_REF = 'c'.repeat(43);

const workspace = (ref: string, displayLabel: string) => ({ workspaceRef: ref, workspaceType: 'business', accessMode: 'owner', displayLabel });

const SERIES = [
  { month: '1405-04', startsAt: '2026-06-21T20:30:00.000Z', endsAt: '2026-07-22T20:30:00.000Z', settledToman: 100_000, reversedToman: 0, settlementCount: 1, complete: true },
  { month: '1405-05', startsAt: '2026-07-22T20:30:00.000Z', endsAt: '2026-08-22T20:30:00.000Z', settledToman: 0, reversedToman: 0, settlementCount: 0, complete: true },
  { month: '1405-06', startsAt: '2026-08-22T20:30:00.000Z', endsAt: '2026-09-22T20:30:00.000Z', settledToman: 350_000, reversedToman: 100_000, settlementCount: 2, complete: true },
  { month: '1405-07', startsAt: '2026-09-22T20:30:00.000Z', endsAt: '2026-10-22T20:30:00.000Z', settledToman: 40_000, reversedToman: 0, settlementCount: 1, complete: false },
];

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function failed(status: number, code: string, message = 'خطای سرور') {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
}

interface Options {
  workspaces?: unknown[];
  workspacesAfterReload?: unknown[];
  seriesFor?: (ref: string, attempt: number) => Promise<unknown>;
}

function mockApi(options: Options = {}) {
  let workspaceReads = 0;
  const seriesAttempts = new Map<string, number>();
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    if (url.includes('/v1/me/finance/workspaces')) {
      workspaceReads += 1;
      const items = workspaceReads > 1 && options.workspacesAfterReload ? options.workspacesAfterReload : options.workspaces ?? [workspace(REF, 'سالن نور')];
      return ok({ items });
    }
    const ref = [REF, OTHER_REF].find((r) => url.includes(r)) ?? '';
    if (url.includes('/settlement-series')) {
      const attempt = (seriesAttempts.get(ref) ?? 0) + 1;
      seriesAttempts.set(ref, attempt);
      return options.seriesFor ? options.seriesFor(ref, attempt) : ok({ items: SERIES, currency: 'IRT' });
    }
    if (url.includes('/summary')) return ok({ partyType: 'business', receivableNetToman: 3_000_000, settledToman: 1_000_000, outstandingToman: 2_000_000, currency: 'IRT' });
    if (url.includes('/funds')) return ok({ pending: 0, disputed: 0, available: 0, reserve: 0, settled: 0, refunded: 0, platformEarned: 0, providerFee: 0, recoveryOut: 0, collected: 0, platformAdvance: 0, recoveredIn: 0, currency: 'IRT' });
    if (url.includes('/outstanding-orders')) return ok([]);
    if (url.includes('/settlements')) {
      // One page, whose amounts deliberately add up to NOTHING the chart shows:
      // a chart built from this page would be visibly wrong.
      return ok({
        items: [{ id: 's1', kind: 'settlement', amountToman: 9_999_000, currency: 'IRT', method: 'card', reference: null, createdAt: '2026-09-25T10:00:00.000Z' }],
        nextCursor: 'next-page',
      });
    }
    return ok([]);
  });
}

const renderFinance = () =>
  render(
    <AuthProvider>
      <FinancePage />
    </AuthProvider>,
  );

const seriesCalls = () => (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/settlement-series'));

/** The chart's always-present table: the accessible equivalent of the plot. */
async function trendTable() {
  const caption = await screen.findByText('تسویهٔ ماهانه', { selector: 'caption' });
  return caption.closest('table') as HTMLTableElement;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'access-token', csrfToken: 'test-csrf-token' });
});

describe('the four-month settlement trend (#255)', () => {
  it('draws the server’s four Jalali months, oldest first, the running month marked as to date', async () => {
    mockApi();
    renderFinance();

    const table = await trendTable();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'تیر ۱۴۰۵',
      'مرداد ۱۴۰۵',
      'شهریور ۱۴۰۵',
      'مهر ۱۴۰۵ (تا امروز)',
    ]);
    // The bar is what was SETTLED; a reversal is its own fact in the row, never netted in.
    expect(rows[2]).toHaveTextContent('۳۵۰٬۰۰۰ تومان');
    expect(rows[2]).toHaveTextContent('۲ تسویه، ۱۰۰٬۰۰۰ تومان برگشتی');
    expect(rows[1]).toHaveTextContent('۰ تسویه');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['ماه', 'تسویه‌شده', 'جزئیات']);

    // Announced as four MONTHS, not four days.
    expect(screen.getByRole('img', { name: /تسویهٔ ماهانه: ۴ ماه،/ })).toBeInTheDocument();
    expect(screen.getByText(/ماه‌ها شمسی و به وقت تهران‌اند/)).toBeInTheDocument();
  });

  it('comes from the series route for the active workspace, never from the paged settlement table', async () => {
    mockApi();
    renderFinance();

    const table = await trendTable();
    expect(seriesCalls()).toEqual([expect.stringContaining(`/v1/me/finance/${REF}/settlement-series`)]);
    // The first settlement page holds 9 999 000; nothing in the chart does.
    expect(table).not.toHaveTextContent('۹٬۹۹۹٬۰۰۰');
    expect(await screen.findByText(/۹٬۹۹۹٬۰۰۰|9,999,000/)).toBeInTheDocument(); // …while the table beside it still shows it.
  });

  it('fails on its own: the other sections stay, and only this one offers a retry', async () => {
    mockApi({
      seriesFor: (_ref, attempt) =>
        attempt === 1 ? failed(503, 'SERVICE_UNAVAILABLE', 'سرویس موقتاً در دسترس نیست.') : ok({ items: SERIES, currency: 'IRT' }),
    });
    const user = userEvent.setup();
    renderFinance();

    const heading = await screen.findByRole('heading', { name: 'روند تسویه در چهار ماه اخیر' });
    // The server's own words, as every section on this page shows them.
    expect(await screen.findByText('سرویس موقتاً در دسترس نیست.')).toBeInTheDocument();
    // Summary and settlement history are untouched by this failure.
    expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'تاریخچه تسویه' })).toBeInTheDocument();
    expect(heading).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /تلاش دوباره/ }));
    expect(await trendTable()).toBeInTheDocument();
    expect(seriesCalls()).toHaveLength(2);
  });

  it('treats a refusal on the series like any other read’s: the workspace is dropped and nothing of it stays', async () => {
    mockApi({
      workspaces: [workspace(REF, 'سالن نور'), workspace(OTHER_REF, 'کلینیک آفتاب')],
      workspacesAfterReload: [workspace(OTHER_REF, 'کلینیک آفتاب')],
      seriesFor: (ref) =>
        ref === REF
          ? failed(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد پیدا نشد یا در دسترس شما نیست.')
          : ok({ items: SERIES.map((m) => ({ ...m, settledToman: 7 })), currency: 'IRT' }),
    });
    const user = userEvent.setup();
    renderFinance();

    await user.click(await screen.findByRole('radio', { name: /سالن نور/ }));
    // The refused workspace leaves the list; the one that remains is a list of
    // one, so it opens directly -- and the chart now shown is ITS series.
    await waitFor(() => expect(screen.queryByText('سالن نور')).not.toBeInTheDocument());
    const table = await trendTable();
    expect(table).toHaveTextContent('۷ تومان');
    expect(screen.queryByText('این مورد پیدا نشد یا در دسترس شما نیست.')).not.toBeInTheDocument();
    expect(seriesCalls().filter((u) => u.includes(REF))).toHaveLength(1);
  });

  it('clears one workspace’s trend before another’s is drawn', async () => {
    let releaseOther: (value: unknown) => void = () => {};
    mockApi({
      workspaces: [workspace(REF, 'سالن نور'), workspace(OTHER_REF, 'کلینیک آفتاب')],
      seriesFor: (ref) =>
        ref === REF
          ? ok({ items: SERIES, currency: 'IRT' })
          : new Promise((resolve) => {
              releaseOther = () => resolve({ ok: true, status: 200, json: async () => ({ data: { items: SERIES.map((m) => ({ ...m, settledToman: 1 })), currency: 'IRT' }, meta: null, error: null }) });
            }),
    });
    const user = userEvent.setup();
    renderFinance();

    await user.click(await screen.findByRole('radio', { name: /سالن نور/ }));
    expect(await trendTable()).toHaveTextContent('۳۵۰٬۰۰۰');

    await user.click(screen.getByRole('radio', { name: /کلینیک آفتاب/ }));
    // Loading, and none of the first workspace's figures beneath it.
    expect(await screen.findByText('در حال بارگذاری نمودار…')).toBeInTheDocument();
    expect(screen.queryByText('تسویهٔ ماهانه', { selector: 'caption' })).not.toBeInTheDocument();

    releaseOther(undefined);
    const table = await trendTable();
    expect(table).not.toHaveTextContent('۳۵۰٬۰۰۰');
    expect(table).toHaveTextContent('۱ تومان');
  });

  it('shows a re-selected workspace as loading until its fresh answer, never the figures from before', async () => {
    // A -> B (B still loading) -> A again. The first answer for A must not be
    // shown again while A's second read is in flight: every section on this
    // page shows loading then, and the chart is no exception.
    let releaseSecondA: () => void = () => {};
    mockApi({
      workspaces: [workspace(REF, 'سالن نور'), workspace(OTHER_REF, 'کلینیک آفتاب')],
      seriesFor: (ref, attempt) => {
        if (ref === OTHER_REF) return new Promise(() => {});
        if (attempt === 1) return ok({ items: SERIES, currency: 'IRT' });
        return new Promise((resolve) => {
          releaseSecondA = () =>
            resolve({ ok: true, status: 200, json: async () => ({ data: { items: SERIES.map((m) => ({ ...m, settledToman: 2 })), currency: 'IRT' }, meta: null, error: null }) });
        });
      },
    });
    const user = userEvent.setup();
    renderFinance();

    await user.click(await screen.findByRole('radio', { name: /سالن نور/ }));
    expect(await trendTable()).toHaveTextContent('۳۵۰٬۰۰۰');
    await user.click(screen.getByRole('radio', { name: /کلینیک آفتاب/ }));
    await user.click(screen.getByRole('radio', { name: /سالن نور/ }));

    expect(await screen.findByText('در حال بارگذاری نمودار…')).toBeInTheDocument();
    expect(screen.queryByText('تسویهٔ ماهانه', { selector: 'caption' })).not.toBeInTheDocument();

    releaseSecondA();
    const table = await trendTable();
    expect(table).toHaveTextContent('۲ تومان');
    expect(table).not.toHaveTextContent('۳۵۰٬۰۰۰');
  });
});

/*
 * Codex review of 518b3a5: a series answer for workspace A that arrives AFTER
 * the user has moved to B -- and B has already drawn -- belongs to a
 * selection that no longer exists. Each test holds A's response in the test's
 * own hand and releases it only once B is on screen, so the out-of-order
 * arrival is certain rather than a timing accident.
 */
describe('a late answer for a workspace the user has left (#255 review)', () => {
  const A = workspace(REF, 'سالن نور');
  const B = workspace(OTHER_REF, 'کلینیک آفتاب');
  const B_SERIES = { items: SERIES.map((m) => ({ ...m, settledToman: 8 })), currency: 'IRT' };

  function held() {
    let release!: (response: unknown) => void;
    const promise = new Promise((resolve) => (release = resolve));
    return { promise, release };
  }
  const answer = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
  const refusal = (status: number, code: string, message: string) => ({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message } }),
  });

  /** A selected with its series held, then B selected and drawn. */
  async function moveToBWhileAIsPending(heldA: Promise<unknown>) {
    mockApi({
      workspaces: [A, B],
      seriesFor: (ref) => (ref === REF ? heldA : ok(B_SERIES)),
    });
    const user = userEvent.setup();
    renderFinance();
    await user.click(await screen.findByRole('radio', { name: /سالن نور/ }));
    expect(await screen.findByText('در حال بارگذاری نمودار…')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /کلینیک آفتاب/ }));
    expect(await trendTable()).toHaveTextContent('۸ تومان');
    return user;
  }

  /** Lets a released response travel all the way through the component. */
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

  const workspaceReads = () =>
    (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/me/finance/workspaces')).length;

  function expectBStillDrawn() {
    expect(screen.getByRole('radio', { name: /کلینیک آفتاب/ })).toBeChecked();
    const table = screen.getByText('تسویهٔ ماهانه', { selector: 'caption' }).closest('table') as HTMLTableElement;
    expect(table).toHaveTextContent('۸ تومان');
    expect(table).not.toHaveTextContent('۳۵۰٬۰۰۰');
    expect(screen.queryByText('در حال بارگذاری نمودار…')).not.toBeInTheDocument();
  }

  it('ignores A’s late success: B’s chart stays drawn and never shows A’s figures', async () => {
    const lateA = held();
    await moveToBWhileAIsPending(lateA.promise);

    lateA.release(answer({ items: SERIES, currency: 'IRT' }));
    await settle();
    expectBStillDrawn();
  });

  it('ignores A’s late failure: no error of A’s is shown under B', async () => {
    const lateA = held();
    await moveToBWhileAIsPending(lateA.promise);

    lateA.release(refusal(503, 'SERVICE_UNAVAILABLE', 'سرویس موقتاً در دسترس نیست.'));
    await settle();
    expectBStillDrawn();
    expect(screen.queryByText('سرویس موقتاً در دسترس نیست.')).not.toBeInTheDocument();
  });

  it('ignores A’s late refusal: B is not cleared, A is not dropped, the list is not reloaded', async () => {
    const lateA = held();
    await moveToBWhileAIsPending(lateA.promise);
    const readsBefore = workspaceReads();

    lateA.release(refusal(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد پیدا نشد یا در دسترس شما نیست.'));
    await settle();
    expectBStillDrawn();
    expect(screen.getByRole('radio', { name: /سالن نور/ })).toBeInTheDocument();
    expect(workspaceReads()).toBe(readsBefore);
  });

  it('ignores a superseded retry: A’s retried read landing after the move to B changes nothing', async () => {
    const retriedA = held();
    mockApi({
      workspaces: [A, B],
      seriesFor: (ref, attempt) => {
        if (ref !== REF) return ok(B_SERIES);
        return attempt === 1 ? failed(503, 'SERVICE_UNAVAILABLE', 'سرویس موقتاً در دسترس نیست.') : (retriedA.promise as Promise<unknown>);
      },
    });
    const user = userEvent.setup();
    renderFinance();
    await user.click(await screen.findByRole('radio', { name: /سالن نور/ }));
    await user.click(await screen.findByRole('button', { name: /تلاش دوباره/ }));
    await user.click(screen.getByRole('radio', { name: /کلینیک آفتاب/ }));
    expect(await trendTable()).toHaveTextContent('۸ تومان');

    retriedA.release(answer({ items: SERIES, currency: 'IRT' }));
    await settle();
    expectBStillDrawn();
  });
});
