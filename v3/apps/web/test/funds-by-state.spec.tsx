import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancePage from '@/app/finance/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/finance',
}));

/**
 * The per-state funds section of screen 46 — V3.3 `#43a` / #185, ADR-052 §14
 * and §16, design `46_FINANCE_WORKSPACE_AMENDMENT.md` with its reviewer
 * corrections.
 *
 * ## What these cases are about
 *
 * Not "does the section render". The three properties that make this section
 * correct rather than merely present:
 *
 *  1. **The boundary is three-way.** `collected`, `platformAdvance` and
 *     `recoveredIn` are custody facts, not the seller's money. A reader who
 *     adds them to their own states, or a future edit that quietly folds them
 *     back into the seller group, is what these cases catch.
 *  2. **Nothing is summed.** Not across the boundary and not within the seller
 *     group. Every figure on screen must be one the server sent.
 *  3. **All-zero is an answer, not an absence.** It renders zeros and a
 *     sentence — never an empty state, never an error.
 *
 * ## The figures are deliberately unique
 *
 * No two fields share a digit sequence, and no two sum to a third, so a
 * mis-grouped card or an invented total is visible as a specific wrong number
 * rather than as a plausible one.
 */

const WORKSPACE_REF = 'w'.repeat(43);

const WORKSPACE = {
  workspaceRef: WORKSPACE_REF,
  workspaceType: 'business' as const,
  accessMode: 'owner' as const,
  displayLabel: 'سالن نور',
};

const SUMMARY = {
  partyType: 'business' as const,
  receivableNetToman: 9_999_000,
  settledToman: 8_888_000,
  outstandingToman: 7_777_000,
  currency: 'IRT',
};

/** Distinct, non-summing values — see the header note. */
const FUNDS = {
  pending: 111_000,
  disputed: 222_000,
  available: 333_000,
  reserve: 444_000,
  settled: 555_000,
  refunded: 666_000,
  collected: 1_230_000,
  platformAdvance: 1_340_000,
  recoveredIn: 1_450_000,
  platformEarned: 2_560_000,
  providerFee: 2_670_000,
  recoveryOut: 2_780_000,
  currency: 'IRT',
};

const ALL_ZERO = Object.fromEntries(Object.keys(FUNDS).map((k) => [k, k === 'currency' ? 'IRT' : 0])) as typeof FUNDS;

const SELLER_STATES = ['pending', 'disputed', 'available', 'reserve', 'settled', 'refunded'] as const;
const CUSTODY_FACTS = ['collected', 'platformAdvance', 'recoveredIn'] as const;
const PLATFORM_FACTS = ['platformEarned', 'providerFee', 'recoveryOut'] as const;

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

function mockApi(options: { funds?: typeof FUNDS; fundsFails?: number; accessMode?: 'owner' | 'finance_read' } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) return ok({ id: 'prof-1', displayName: 'نمایه', verificationStatus: 'verified' });
    if (url.includes('/v1/me/finance/workspaces')) {
      return ok({ items: [{ ...WORKSPACE, accessMode: options.accessMode ?? 'owner' }] });
    }
    if (url.includes('/funds')) {
      if (options.fundsFails) return refused(options.fundsFails, 'INTERNAL_ERROR');
      return ok(options.funds ?? FUNDS);
    }
    if (url.includes('/summary')) return ok(SUMMARY);
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
        <FinancePage />
      </ProProvider>
    </AuthProvider>,
  );
}

/** The section, once it has rendered. Scopes every query away from the legacy trio above it. */
async function fundsSection(): Promise<HTMLElement> {
  return (await screen.findByTestId('funds-by-state')) as HTMLElement;
}

/** The card for one wire field. The name is an attribute, not rendered text -- see `FundAmount`. */
function card(scope: HTMLElement, field: string): HTMLElement | null {
  return scope.querySelector(`[data-field="${field}"]`);
}

/** The bounded block whose heading contains `text`, as the reader sees it grouped. */
function groupContaining(section: HTMLElement, text: string): HTMLElement {
  const heading = within(section).getByText((_, node) => !!node?.textContent?.includes(text) && node.tagName === 'H3');
  const block = heading.closest('section');
  if (!block) throw new Error(`no section around heading containing "${text}"`);
  return block as HTMLElement;
}

beforeEach(() => {
  // A fresh mock per case: `global.fetch` is not stubbed by the shared setup,
  // so each suite installs its own (matching `finance-workspaces.spec.tsx`).
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  authenticate();
});

describe('screen 46 — the per-state funds section', () => {
  it('renders all twelve fields, and reads each one from the server', async () => {
    mockApi();
    renderFinance();

    const section = await fundsSection();
    for (const field of [...SELLER_STATES, ...CUSTODY_FACTS, ...PLATFORM_FACTS]) {
      // Addressed by its wire name, so a mis-labelled card is caught by
      // identity rather than only by value.
      expect(card(section, field)).not.toBeNull();
    }
  });

  it('keeps the custody facts OUT of the seller group and in their own bounded block', async () => {
    mockApi();
    renderFinance();

    const section = await fundsSection();
    const custody = groupContaining(section, 'واقعیت‌های امانت');
    const platform = groupContaining(section, 'آن سوی مرز');

    // The three custody facts are inside the custody block...
    for (const field of CUSTODY_FACTS) expect(card(custody, field)).not.toBeNull();
    // ...and none of the seller's own states is.
    for (const field of SELLER_STATES) expect(card(custody, field)).toBeNull();
    // The platform block stays a third, separate thing.
    for (const field of PLATFORM_FACTS) expect(card(platform, field)).not.toBeNull();
    for (const field of CUSTODY_FACTS) expect(card(platform, field)).toBeNull();
  });

  it('says in words that the custody figures are not the reader’s balance', async () => {
    mockApi();
    renderFinance();

    const custody = groupContaining(await fundsSection(), 'واقعیت‌های امانت');
    // Text and shape, not colour: the claim has to survive a monochrome render.
    expect(custody.textContent).toContain('نه ماندهٔ شما');
    expect(custody.textContent).toContain('قابلِ پرداخت به شما نیستند');
  });

  it('invents no total — every number on the section is one the server sent', async () => {
    mockApi();
    renderFinance();

    const section = await fundsSection();
    const digits = (section.textContent ?? '').replace(/[^۰-۹٠-٩\d]/g, '');

    const sent = new Set(Object.entries(FUNDS).filter(([k]) => k !== 'currency').map(([, v]) => v as number));
    const forbidden = [
      SELLER_STATES.reduce((a, f) => a + FUNDS[f], 0),
      CUSTODY_FACTS.reduce((a, f) => a + FUNDS[f], 0),
      PLATFORM_FACTS.reduce((a, f) => a + FUNDS[f], 0),
      Object.entries(FUNDS).filter(([k]) => k !== 'currency').reduce((a, [, v]) => a + (v as number), 0),
      SUMMARY.receivableNetToman + FUNDS.pending,
    ];

    for (const total of forbidden) {
      expect(sent.has(total)).toBe(false); // the fixture must not make a total look legitimate
      const latin = String(total);
      const persian = latin.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
      expect(digits).not.toContain(latin);
      expect(digits).not.toContain(persian);
    }

    // Nor the words a summary figure would be given.
    expect(section.textContent).not.toContain('موجودی');
    expect(section.textContent).not.toContain('جمع کل');
  });

  it('renders all-zero as zeros with an explanation — not an empty state and not an error', async () => {
    mockApi({ funds: ALL_ZERO });
    renderFinance();

    const section = await fundsSection();
    // Every card is still there.
    for (const field of [...SELLER_STATES, ...CUSTODY_FACTS, ...PLATFORM_FACTS]) {
      expect(card(section, field)).not.toBeNull();
    }
    expect(within(section).getByRole('note').textContent).toContain('پاسخِ درستِ سرور است');
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('shows no explanatory note when the figures are not all zero', async () => {
    mockApi();
    renderFinance();

    const section = await fundsSection();
    expect(within(section).queryByRole('note')).toBeNull();
  });

  it('fails on its own — a funds error leaves the legacy figures standing, and retries', async () => {
    mockApi({ fundsFails: 500 });
    renderFinance();

    // The legacy trio loaded from its own request and must be untouched.
    expect(await screen.findByText('۹٬۹۹۹٬۰۰۰')).toBeInTheDocument();
    expect(screen.queryByTestId('funds-by-state')).toBeNull();

    const retry = await screen.findByRole('button', { name: /تلاش دوباره|تلاش مجدد/ });

    // The retry succeeds, and only this section changes.
    mockApi();
    await userEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('funds-by-state')).toBeInTheDocument());
    expect(screen.getByText('۹٬۹۹۹٬۰۰۰')).toBeInTheDocument();
  });

  it('gives a finance_read grantee the identical projection', async () => {
    mockApi({ accessMode: 'finance_read' });
    renderFinance();

    const section = await fundsSection();
    for (const field of [...SELLER_STATES, ...CUSTODY_FACTS, ...PLATFORM_FACTS]) {
      expect(card(section, field)).not.toBeNull();
    }
    // Read-only is stated once, for the workspace — never as a disabled
    // control inside this section.
    expect(within(section).queryByRole('button')).toBeNull();
  });

  it('never renders `currency` as a thirteenth fund state', async () => {
    mockApi();
    renderFinance();

    const section = await fundsSection();
    expect(card(section, 'currency')).toBeNull();
    expect(section.textContent).not.toContain('IRT');
    // Exactly twelve cards, so a thirteenth of any kind fails here too.
    expect(section.querySelectorAll('[data-field]')).toHaveLength(12);
  });
});
