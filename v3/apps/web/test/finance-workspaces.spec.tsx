import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProFinancePage from '@/app/pro/finance/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/finance',
}));

/**
 * The finance screen after the workspace migration — V3.3 #72 (`V33-DEC-020`),
 * widened by #111/#154 and Story #152 (`#149b`) into the shared
 * `FinanceWorkspaceSurface` that `/pro/finance` now delegates to.
 *
 * ## What these cases are actually about
 *
 * The screen used to call four singular routes and render whatever party the
 * server picked. A dual owner saw their business figures with nothing saying
 * their professional earnings existed, and an affiliated staff professional saw
 * their EMPLOYER's position. Since #152, it must ALSO never pick a default
 * workspace for a caller who owns or is granted more than one — the previous
 * `items[0]` fallback here was exactly the defect `V33-DEC-020` forbids, and
 * `/pro/finance` inherits the fix because it shares the one component.
 *
 * So the cases below are not "does the page render" — they are: does it ask
 * which workspace, does it refuse to guess when there are several, does
 * switching genuinely re-fetch, and can one workspace's numbers ever appear
 * under another's heading.
 *
 * ## The figures are deliberately distinguishable
 *
 * `PROFESSIONAL` and `BUSINESS` share no digit sequence, so a mixed cache is
 * visible as a wrong number on screen rather than as a subtly wrong total.
 */

const PROFESSIONAL_REF = 'p'.repeat(43);
const BUSINESS_REF = 'b'.repeat(43);

const PROFESSIONAL_WORKSPACE = {
  workspaceRef: PROFESSIONAL_REF,
  workspaceType: 'professional' as const,
  accessMode: 'owner' as const,
  displayLabel: 'نمایه',
};

const BUSINESS_WORKSPACE = {
  workspaceRef: BUSINESS_REF,
  workspaceType: 'business' as const,
  accessMode: 'owner' as const,
  displayLabel: 'سالن نور',
};

// Every figure on this page is distinct, within a summary and across the two.
// Three stat cards showing one repeated number would make `findByText` ambiguous
// AND would hide a panel that failed to update.
const PROFESSIONAL_SUMMARY = {
  partyType: 'professional' as const,
  receivableNetToman: 1_111_000,
  settledToman: 100_000,
  outstandingToman: 1_011_000,
  currency: 'IRT',
};

const BUSINESS_SUMMARY = {
  partyType: 'business' as const,
  receivableNetToman: 2_222_000,
  settledToman: 200_000,
  outstandingToman: 2_022_000,
  currency: 'IRT',
};

function authenticate() {
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
}

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message: 'خطا' } }),
  });
}

/**
 * Routes every request this screen makes.
 *
 * `workspaces` is what the test is usually varying; the per-workspace handlers
 * answer by the reference in the URL, which is the property under test — a
 * handler that ignored the reference would make a mixed-cache bug invisible.
 */
function mockApi(options: {
  workspaces?: Array<{ workspaceRef: string; workspaceType: 'professional' | 'business'; accessMode: 'owner' | 'finance_read'; displayLabel: string }>;
  workspacesFails?: boolean;
}) {
  const workspaces = options.workspaces ?? [PROFESSIONAL_WORKSPACE];

  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) return ok({ id: 'prof-1', displayName: 'نمایه', verificationStatus: 'verified' });

    if (url.includes('/v1/me/finance/workspaces')) {
      return options.workspacesFails ? refused(500, 'INTERNAL_ERROR') : ok({ items: workspaces });
    }

    const forProfessional = url.includes(PROFESSIONAL_REF);
    const forBusiness = url.includes(BUSINESS_REF);

    if (url.includes('/summary')) {
      if (forProfessional) return ok(PROFESSIONAL_SUMMARY);
      if (forBusiness) return ok(BUSINESS_SUMMARY);
      return refused(404, 'NOT_FOUND_OR_NOT_YOURS');
    }
    if (url.includes('/outstanding-orders')) return ok([]);
    if (url.includes('/settlements')) return ok({ items: [], nextCursor: null });
    if (url.includes('/ledger')) return ok([]);

    return ok([]);
  });
}

function renderFinance() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProFinancePage />
      </ProProvider>
    </AuthProvider>,
  );
}

/** The workspace-selection fieldset's accessible name — native `<fieldset>`/`<legend>`, not `aria-label`. */
const SELECTOR_NAME = 'کدام فضای مالی؟';

beforeEach(() => {
  // A fresh mock per case, matching `pro-surface.spec.tsx`: `global.fetch` is
  // not stubbed by the shared setup, so each suite installs its own.
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  authenticate();
});

describe('a seller who owns one workspace', () => {
  it('renders their figures with no selector to choose between', async () => {
    mockApi({});
    renderFinance();

    expect(await screen.findByText(/۱٬۱۱۱٬۰۰۰|1,111,000/)).toBeInTheDocument();
    // No selector: a group of one is a puzzle, not a control.
    expect(screen.queryByRole('group', { name: SELECTOR_NAME })).not.toBeInTheDocument();
  });

  it('addresses the summary by workspaceRef, not by a singular route', async () => {
    mockApi({});
    renderFinance();
    await screen.findByText(/۱٬۱۱۱٬۰۰۰|1,111,000/);

    const requested: string[] = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes(`/v1/me/finance/${PROFESSIONAL_REF}/summary`))).toBe(true);
    // The old singular route is not called at all — the migration is complete
    // rather than additive on the client.
    expect(requested.some((url) => /\/v1\/me\/finance\/summary$/.test(url))).toBe(false);
  });
});

describe('a seller who owns nothing', () => {
  it('shows a truthful empty state rather than an error', async () => {
    // Owning no seller workspace is a legitimate state. The API answers `[]`,
    // and the screen must not render that as a failure.
    mockApi({ workspaces: [] });
    renderFinance();

    expect(await screen.findByText('در حال حاضر دسترسیِ مالی‌ای ندارید.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });
});

describe('an affiliated staff professional', () => {
  it('sees their own zero, and never the employer figures', async () => {
    /*
     * `V33-DEC-020` accepts this outcome explicitly: their earnings belong to
     * the business, so their own workspace is genuinely zero, and the client
     * must not paper over it.
     */
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
      if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+98912', displayName: null, roles: [], capabilities: [] });
      if (url.includes('/v1/me/provider')) return ok({ id: 'prof-1', displayName: 'کارمند', verificationStatus: 'verified' });
      if (url.includes('/v1/me/finance/workspaces')) {
        return ok({ items: [PROFESSIONAL_WORKSPACE] });
      }
      if (url.includes('/summary')) {
        return ok({ partyType: 'professional', receivableNetToman: 0, settledToman: 0, outstandingToman: 0, currency: 'IRT' });
      }
      if (url.includes('/settlements')) return ok({ items: [], nextCursor: null });
      return ok([]);
    });

    renderFinance();

    // A generous timeout on both the query and the surrounding test itself:
    // this case waits on several sequential requests (session, provider
    // profile, workspace list, then summary/orders/settlements) before the
    // assertion renders, which was observed flaky against RTL's 1000ms
    // default and jest's 5000ms per-test default under load.
    expect(await screen.findByText('سفارشی در انتظار تسویه ندارید.', {}, { timeout: 10000 })).toBeInTheDocument();
    // The employer's distinguishable figure appears nowhere on the page.
    expect(screen.queryByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).not.toBeInTheDocument();
  }, 15000);
});

describe('a workspace whose sections are still loading', () => {
  const NO_ORDERS = 'سفارشی در انتظار تسویه ندارید.';
  const NO_SETTLEMENTS = 'هنوز تسویه‌ای انجام نشده است.';

  it('never claims "no orders" or "no settlements" before those requests have settled', async () => {
    /*
     * The workspace used to become active one render BEFORE its sections
     * started loading, so that render said "no orders awaiting settlement" and
     * "no settlement yet" about requests that had not been sent. It was a
     * false statement on screen for one frame, and it was the cause of the
     * CI-only failure of the staff case below: `findByText` could resolve on
     * that transient node, which the loading state then detached.
     *
     * A `MutationObserver` watches every DOM change for the whole time both
     * responses are held, so even a single committed frame is caught — a
     * point-in-time `queryByText` would miss it.
     */
    let releaseOrders!: () => void;
    let releaseSettlements!: () => void;
    const ordersHeld = new Promise<void>((resolve) => (releaseOrders = resolve));
    const settlementsHeld = new Promise<void>((resolve) => (releaseSettlements = resolve));
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
      if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+98912', displayName: null, roles: [], capabilities: [] });
      if (url.includes('/v1/me/provider')) return ok({ id: 'prof-1', displayName: 'نمایه', verificationStatus: 'verified' });
      if (url.includes('/v1/me/finance/workspaces')) return ok({ items: [PROFESSIONAL_WORKSPACE] });
      if (url.includes('/summary')) return ok(PROFESSIONAL_SUMMARY);
      if (url.includes('/outstanding-orders')) return ordersHeld.then(() => ok([]));
      if (url.includes('/settlements')) return settlementsHeld.then(() => ok({ items: [], nextCursor: null }));
      return ok([]);
    });

    const claimedBeforeSettling = new Set<string>();
    const observer = new MutationObserver(() => {
      const text = document.body.textContent ?? '';
      if (text.includes(NO_ORDERS)) claimedBeforeSettling.add('orders');
      if (text.includes(NO_SETTLEMENTS)) claimedBeforeSettling.add('settlements');
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      renderFinance();
      // The workspace is open and its summary has rendered: every frame that
      // used to flash is behind us, and both sections are still unanswered.
      expect(await screen.findByText(/۱٬۱۱۱٬۰۰۰|1,111,000/, {}, { timeout: 10000 })).toBeInTheDocument();
      expect([...claimedBeforeSettling]).toEqual([]);
    } finally {
      observer.disconnect();
    }

    // Once the server has actually answered "none", saying so is truthful.
    releaseOrders();
    releaseSettlements();
    expect(await screen.findByText(NO_ORDERS, {}, { timeout: 10000 })).toBeInTheDocument();
    expect(await screen.findByText(NO_SETTLEMENTS, {}, { timeout: 10000 })).toBeInTheDocument();
  }, 20000);
});

describe('a dual owner', () => {
  const both = [BUSINESS_WORKSPACE, PROFESSIONAL_WORKSPACE];

  it('gets an accessible selector naming both workspaces, with NEITHER preselected', async () => {
    mockApi({ workspaces: both });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    const radios = within(group).getAllByRole('radio');

    expect(radios).toHaveLength(2);
    // V3.3 Story #152: never `items[0]`. Nothing is checked until the caller
    // picks, and no figure is shown until then either.
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText(/۱٬۱۱۱٬۰۰۰|1,111,000|۲٬۲۲۲٬۰۰۰|2,222,000/)).not.toBeInTheDocument();

    // Each workspace is named by its server-supplied `displayLabel`, never by
    // `workspaceType` alone.
    expect(within(group).getByText('سالن نور')).toBeInTheDocument();
    expect(within(group).getByText('نمایه')).toBeInTheDocument();
  });

  it('loads the chosen workspace only after an explicit selection', async () => {
    mockApi({ workspaces: both });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    await userEvent.click(within(group).getByText('سالن نور'));

    await waitFor(() => expect(screen.getByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).toBeInTheDocument());
    const radios = within(group).getAllByRole('radio');
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
  });

  it('never shows one workspace figure under the other, even for an instant', async () => {
    /*
     * The mixed-cache bug this migration has to avoid: a slow response leaving
     * the previous workspace's numbers rendered under the new selection. The
     * screen clears every panel BEFORE the next request starts, so the old
     * figure is gone the moment the selection changes.
     */
    mockApi({ workspaces: both });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).toBeInTheDocument());

    await userEvent.click(within(group).getByText('نمایه'));
    await waitFor(() => expect(screen.getByText(/۱٬۱۱۱٬۰۰۰|1,111,000/)).toBeInTheDocument());
    // The business figure is not merely superseded — it is not on the page.
    expect(screen.queryByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).not.toBeInTheDocument();
  });

  it('requests each workspace by its own reference', async () => {
    mockApi({ workspaces: both });
    renderFinance();

    const group = await screen.findByRole('group', { name: SELECTOR_NAME });
    await userEvent.click(within(group).getByText('سالن نور'));
    await waitFor(() => expect(screen.getByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).toBeInTheDocument());

    await userEvent.click(within(group).getByText('نمایه'));
    await waitFor(() => expect(screen.getByText(/۱٬۱۱۱٬۰۰۰|1,111,000/)).toBeInTheDocument());

    const requested: string[] = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes(`${BUSINESS_REF}/summary`))).toBe(true);
    expect(requested.some((url) => url.includes(`${PROFESSIONAL_REF}/summary`))).toBe(true);
  });
});

describe('failure states stay distinct', () => {
  it('offers a retry when the workspace list itself fails, and does not fake an empty state', async () => {
    // A failed load must never be mistaken for "you own nothing" — the exact
    // confusion five surfaces shipped before v3.0.1.
    mockApi({ workspacesFails: true });
    renderFinance();

    expect(await screen.findByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
    expect(screen.queryByText('در حال حاضر دسترسیِ مالی‌ای ندارید.')).not.toBeInTheDocument();
  });
});
