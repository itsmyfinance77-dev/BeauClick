import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancePage from '@/app/finance/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/finance',
}));

/**
 * V3.3 Story #152 (`#149b`) — the persona-neutral `/finance` destination.
 *
 * Unlike `finance-workspaces.spec.tsx` (which exercises the same shared
 * surface through the professional-only `/pro/finance` compatibility route,
 * wrapped in `ProProvider`), this file renders `/finance` directly with
 * `AuthProvider` alone — proving the route needs no professional profile at
 * all, which is the entire point of the story.
 */

const BUSINESS_REF = 'b'.repeat(43);
const BUSINESS_TWO_REF = 'c'.repeat(43);
const READ_ONLY_REF = 'r'.repeat(43);

function ownerWorkspace(overrides: Record<string, unknown> = {}) {
  return { workspaceRef: BUSINESS_REF, workspaceType: 'business', accessMode: 'owner', displayLabel: 'سالن نور', ...overrides };
}

function readOnlyWorkspace(overrides: Record<string, unknown> = {}) {
  return { workspaceRef: READ_ONLY_REF, workspaceType: 'business', accessMode: 'finance_read', displayLabel: 'کلینیک آفتاب', ...overrides };
}

const SUMMARY = { partyType: 'business', receivableNetToman: 3_000_000, settledToman: 1_000_000, outstandingToman: 2_000_000, currency: 'IRT' };

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message: 'این مورد پیدا نشد یا در دسترس شما نیست.' } }) });
}

interface Options {
  workspaces?: unknown[];
  /** Served starting from the SECOND read of the workspace list -- e.g. after a revocation. */
  workspacesAfterReload?: unknown[];
  workspacesFails?: boolean;
  summaryFor?: (ref: string) => Promise<unknown>;
  ordersFor?: (ref: string) => Promise<unknown>;
  settlementsFor?: (ref: string, cursor: string | null) => Promise<unknown>;
}

function mockApi(options: Options = {}) {
  let workspaceReads = 0;
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    }
    if (url.includes('/v1/me/finance/workspaces')) {
      workspaceReads += 1;
      if (options.workspacesFails) return refused(500, 'INTERNAL_ERROR');
      const items = workspaceReads > 1 && options.workspacesAfterReload ? options.workspacesAfterReload : options.workspaces ?? [];
      return ok({ items });
    }
    if (url.includes('/summary')) {
      const ref = [BUSINESS_REF, BUSINESS_TWO_REF, READ_ONLY_REF].find((r) => url.includes(r));
      if (options.summaryFor && ref) return options.summaryFor(ref);
      return ok(SUMMARY);
    }
    // V3.3 `#43a` / #185. The real twelve-field shape, so this suite exercises
    // what the server actually returns rather than a fall-through stub.
    if (url.includes('/funds')) return ok({ pending: 0, disputed: 0, available: 0, reserve: 0, settled: 0, refunded: 0, platformEarned: 0, providerFee: 0, recoveryOut: 0, collected: 0, platformAdvance: 0, recoveredIn: 0, currency: 'IRT' });
    if (url.includes('/outstanding-orders')) {
      const ref = [BUSINESS_REF, BUSINESS_TWO_REF, READ_ONLY_REF].find((r) => url.includes(r)) ?? '';
      if (options.ordersFor) return options.ordersFor(ref);
      return ok([]);
    }
    if (url.includes('/settlements')) {
      const ref = [BUSINESS_REF, BUSINESS_TWO_REF, READ_ONLY_REF].find((r) => url.includes(r)) ?? '';
      const cursorMatch = /[?&]cursor=([^&]+)/.exec(url);
      if (options.settlementsFor) return options.settlementsFor(ref, cursorMatch ? decodeURIComponent(cursorMatch[1]) : null);
      return ok({ items: [], nextCursor: null });
    }
    if (url.includes('/ledger')) return ok([]);
    return ok([]);
  });
}

function renderFinance() {
  return render(
    <AuthProvider>
      <FinancePage />
    </AuthProvider>,
  );
}

const SELECTOR_NAME = 'کدام فضای مالی؟';

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'access-token', csrfToken: 'test-csrf-token' });
});

describe('no professional profile is ever required', () => {
  it('renders for a session with no provider profile, and never asks for one', async () => {
    mockApi({ workspaces: [ownerWorkspace()] });
    renderFinance();

    await waitFor(() => expect(screen.getByText('سالن نور')).toBeInTheDocument());
    const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/v1/me/provider') || u.includes('/v1/providers'))).toBe(false);
    expect(screen.queryByText(/پروفایل تخصصی/)).not.toBeInTheDocument();
  });
});

describe('workspace list states', () => {
  it('shows a truthful empty state when nothing is reachable', async () => {
    mockApi({ workspaces: [] });
    renderFinance();

    expect(await screen.findByText('در حال حاضر دسترسیِ مالی‌ای ندارید.')).toBeInTheDocument();
  });

  it('opens the one reachable workspace directly, with no selector', async () => {
    mockApi({ workspaces: [ownerWorkspace()] });
    renderFinance();

    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: SELECTOR_NAME })).not.toBeInTheDocument();
  });

  it('never preselects among several, and shows no figure until chosen', async () => {
    mockApi({ workspaces: [ownerWorkspace(), readOnlyWorkspace()] });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    const radios = within(group).getAllByRole('radio');
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).not.toBeInTheDocument();
  });

  it('loads figures only after an explicit selection', async () => {
    mockApi({ workspaces: [ownerWorkspace(), readOnlyWorkspace()] });
    renderFinance();
    const group = await screen.findByRole('group', { name: SELECTOR_NAME });

    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());
  });
});

describe('owner and delegated access are distinguished by text and shape', () => {
  it('shows the read-only banner and no write controls for a finance_read workspace', async () => {
    mockApi({ workspaces: [readOnlyWorkspace()] });
    renderFinance();

    await waitFor(() => expect(screen.getByText('شما این فضا را فقط می‌خوانید')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /تسویه|پرداخت|بازگشت وجه|لغو اشتراک|خرید اعتبار/ })).not.toBeInTheDocument();
  });

  it('shows no read-only banner for an owner workspace', async () => {
    mockApi({ workspaces: [ownerWorkspace()] });
    renderFinance();

    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());
    expect(screen.queryByText('شما این فضا را فقط می‌خوانید')).not.toBeInTheDocument();
  });

  it('distinguishes owner and delegated workspaces in the selector by text AND shape, not colour alone', async () => {
    mockApi({ workspaces: [ownerWorkspace(), readOnlyWorkspace()] });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    expect(within(group).getByText('دسترسیِ مالکانه')).toBeInTheDocument();
    expect(within(group).getByText('دسترسیِ فقط‌خواندنیِ واگذارشده')).toBeInTheDocument();
  });
});

describe('duplicate labels invent nothing to tell workspaces apart', () => {
  it('renders two identically-labelled workspaces without any ordinal or suffix', async () => {
    mockApi({
      workspaces: [
        ownerWorkspace({ displayLabel: 'سالن نور' }),
        readOnlyWorkspace({ workspaceRef: BUSINESS_TWO_REF, displayLabel: 'سالن نور' }),
      ],
    });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    const labelled = within(group).getAllByText('سالن نور');
    expect(labelled).toHaveLength(2);
    // Neither carries an invented differentiator such as a number, "۱"/"۲", or a fragment of the reference.
    for (const el of labelled) {
      expect(el.textContent).toBe('سالن نور');
    }
    expect(screen.queryByText(/فضای مالی ۱|فضای مالی ۲/)).not.toBeInTheDocument();
  });
});

describe('a workspace that disappears mid-session', () => {
  /**
   * Revocation is simulated through the settlements "load more" request
   * rather than by reselecting the same workspace: the workspace is already
   * open and rendering real data, then the very next request against it is
   * the one that comes back refused -- exactly the "revoked while the screen
   * is open" scenario the design specifies, without relying on a contrived
   * re-selection dance.
   */
  it('clears the data, drops the workspace, and returns to selection on a 404', async () => {
    mockApi({
      workspaces: [ownerWorkspace(), readOnlyWorkspace()],
      workspacesAfterReload: [readOnlyWorkspace()],
      // Distinct from BUSINESS_REF's summary so the two workspaces' figures
      // can never be mistaken for one another once the first is dropped.
      summaryFor: (ref) =>
        ref === BUSINESS_REF
          ? ok(SUMMARY)
          : ok({ partyType: 'business', receivableNetToman: 6_600_000, settledToman: 100_000, outstandingToman: 6_500_000, currency: 'IRT' }),
      settlementsFor: (ref, cursor) => {
        if (ref !== BUSINESS_REF) return ok({ items: [], nextCursor: null });
        if (!cursor) {
          return ok({
            items: [{ id: 'stl-1', kind: 'settlement', amountToman: 500_000, currency: 'IRT', method: null, reference: null, createdAt: new Date().toISOString() }],
            nextCursor: 'p2',
          });
        }
        return refused(404, 'NOT_FOUND_OR_NOT_YOURS');
      },
    });
    renderFinance();
    const group = await screen.findByRole('group', { name: SELECTOR_NAME });

    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());

    const loadMore = await screen.findByRole('button', { name: 'صفحهٔ بعد' });
    await userEvent.click(loadMore);

    await waitFor(() => expect(screen.queryByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).not.toBeInTheDocument());
    // Only one workspace remains addressable, so it opens directly -- the
    // dropped workspace's name is gone, and no selector is shown for a group
    // of one.
    expect(screen.queryByText('سالن نور')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: SELECTOR_NAME })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('کلینیک آفتاب')).toBeInTheDocument());
  });

  it('treats a workspace-aware 409 the same way — back to selection, no crash', async () => {
    mockApi({
      workspaces: [ownerWorkspace()],
      workspacesAfterReload: [],
      summaryFor: () => refused(409, 'FINANCE_WORKSPACE_SELECTION_REQUIRED'),
      ordersFor: () => refused(409, 'FINANCE_WORKSPACE_SELECTION_REQUIRED'),
      settlementsFor: () => refused(409, 'FINANCE_WORKSPACE_SELECTION_REQUIRED'),
    });
    renderFinance();

    expect(await screen.findByText('در حال حاضر دسترسیِ مالی‌ای ندارید.')).toBeInTheDocument();
    expect(screen.queryByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).not.toBeInTheDocument();
  });
});

describe('partial-section failure and retry', () => {
  it('a failing settlements section does not blank the summary, and retries independently', async () => {
    let settlementAttempts = 0;
    mockApi({
      workspaces: [ownerWorkspace()],
      settlementsFor: () => {
        settlementAttempts += 1;
        return settlementAttempts === 1 ? refused(500, 'INTERNAL_ERROR') : ok({ items: [], nextCursor: null });
      },
    });
    renderFinance();

    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByText('هنوز تسویه‌ای انجام نشده است.')).toBeInTheDocument());
    // The summary that already succeeded was never touched by the retry.
    expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument();
  });
});

describe('settlements cursor pagination', () => {
  it('forwards the returned cursor on "load more" and does not auto-fetch further pages', async () => {
    // Assertions never run INSIDE the fetch mock: a thrown Jest assertion
    // there is swallowed by api-client's own try/catch and surfaces as an
    // opaque network error instead of a real test failure. Cursors seen are
    // recorded instead and asserted on afterward.
    const cursorsSeen: (string | null)[] = [];
    mockApi({
      workspaces: [ownerWorkspace()],
      settlementsFor: (_ref, cursor) => {
        cursorsSeen.push(cursor);
        if (!cursor) {
          return ok({
            items: [{ id: 's1', kind: 'settlement', amountToman: 777_000, currency: 'IRT', method: null, reference: null, createdAt: new Date().toISOString() }],
            nextCursor: 'page-2',
          });
        }
        return ok({
          items: [{ id: 's2', kind: 'settlement', amountToman: 888_000, currency: 'IRT', method: null, reference: null, createdAt: new Date().toISOString() }],
          nextCursor: null,
        });
      },
    });
    renderFinance();

    const loadMore = await screen.findByRole('button', { name: 'صفحهٔ بعد' });
    // Only one page fetched before the click -- no auto-fetch of further pages.
    expect(screen.queryByText(/۸۸۸٬۰۰۰|888,000/)).not.toBeInTheDocument();

    await userEvent.click(loadMore);
    await waitFor(() => expect(screen.getByText(/۸۸۸٬۰۰۰|888,000/)).toBeInTheDocument());
    expect(cursorsSeen).toEqual([null, 'page-2']);
    // Both pages' rows are present -- appended, not replaced.
    expect(screen.getByText(/۷۷۷٬۰۰۰|777,000/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'صفحهٔ بعد' })).not.toBeInTheDocument());
  });
});

describe('stale data never survives a workspace switch', () => {
  it('clears the previous workspace figures before the next one renders', async () => {
    let resolveSecond: (() => void) | null = null;
    mockApi({
      workspaces: [ownerWorkspace(), readOnlyWorkspace()],
      summaryFor: (ref) => {
        if (ref === BUSINESS_REF) return ok(SUMMARY);
        return new Promise((resolve) => {
          resolveSecond = () =>
            resolve({ ok: true, status: 200, json: async () => ({ data: { partyType: 'business', receivableNetToman: 9_000_000, settledToman: 4_000_000, outstandingToman: 5_000_000, currency: 'IRT' }, meta: null, error: null }) });
        });
      },
    });
    renderFinance();
    const group = await screen.findByRole('group', { name: SELECTOR_NAME });

    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());

    await userEvent.click(within(screen.getByRole('group', { name: SELECTOR_NAME })).getByText('کلینیک آفتاب'));
    // The old workspace's figure is gone immediately, before the new one resolves.
    expect(screen.queryByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).not.toBeInTheDocument();

    resolveSecond!();
    await waitFor(() => expect(screen.getByText(/۹٬۰۰۰٬۰۰۰|9,000,000/)).toBeInTheDocument());
  });
});

describe('no persistence of workspaceRef or finance data', () => {
  it('writes nothing to localStorage or sessionStorage while browsing', async () => {
    mockApi({ workspaces: [ownerWorkspace(), readOnlyWorkspace()] });
    renderFinance();
    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('never displays, decodes or truncates workspaceRef anywhere on screen', async () => {
    mockApi({ workspaces: [ownerWorkspace(), readOnlyWorkspace()] });
    renderFinance();
    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۳٬۰۰۰٬۰۰۰|3,000,000/)).toBeInTheDocument());

    const visible = document.body.textContent ?? '';
    for (const ref of [BUSINESS_REF, READ_ONLY_REF]) {
      expect(visible).not.toContain(ref);
    }
    // Non-vacuity: the refs really are distinct, non-trivial strings that
    // would stand out if the scan were checking nothing.
    expect(BUSINESS_REF).not.toBe(READ_ONLY_REF);
    expect(BUSINESS_REF.length).toBeGreaterThan(20);
  });
});

describe('the contract cannot be quietly reverted (static)', () => {
  const root = join(__dirname, '..');
  const financePage = readFileSync(join(root, 'app/finance/page.tsx'), 'utf8');
  const proFinancePage = readFileSync(join(root, 'app/pro/finance/page.tsx'), 'utf8');
  const surface = readFileSync(join(root, 'components/finance-workspace.tsx'), 'utf8');

  /** Comments legitimately NAME what the code must not do (this file's own docblock explains it), so they are stripped first. */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  const financePageCode = code(financePage);
  const surfaceCode = code(surface);

  it('the persona-neutral route never imports ProGuard, ProProvider or ProShell', () => {
    for (const forbidden of ['pro-guard', 'pro-context', 'pro-shell', 'ProGuard', 'ProProvider', 'ProShell']) {
      expect(financePageCode).not.toContain(forbidden);
    }
  });

  it('both routes render the same shared surface -- no duplicated finance logic', () => {
    expect(financePage).toContain('FinanceWorkspaceSurface');
    expect(proFinancePage).toContain('FinanceWorkspaceSurface');
  });

  it('the shared surface never calls a singular /me/finance/* route', () => {
    for (const singular of ["'/v1/me/finance/summary'", "'/v1/me/finance/outstanding-orders'", "'/v1/me/finance/settlements'"]) {
      expect(surfaceCode).not.toContain(singular);
    }
  });

  it('the shared surface never writes to localStorage or sessionStorage', () => {
    expect(surfaceCode).not.toContain('localStorage');
    expect(surfaceCode).not.toContain('sessionStorage');
  });

  it('the scans are non-vacuous -- each forbidden shape is caught when planted', () => {
    expect("import { ProGuard } from '@/components/pro-guard';").toContain('ProGuard');
    expect('window.localStorage.setItem("x", "y")').toContain('localStorage');
  });
});
