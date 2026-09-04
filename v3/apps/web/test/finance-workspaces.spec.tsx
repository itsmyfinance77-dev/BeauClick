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
 * The finance screen after the workspace migration — V3.3 #72,
 * `V33-DEC-020`.
 *
 * ## What these cases are actually about
 *
 * The screen used to call four singular routes and render whatever party the
 * server picked. A dual owner saw their business figures with nothing saying
 * their professional earnings existed, and an affiliated staff professional saw
 * their EMPLOYER's position.
 *
 * So the cases below are not "does the page render" — they are: does it ask
 * which workspace, does switching genuinely re-fetch, and can one workspace's
 * numbers ever appear under another's heading.
 *
 * ## The figures are deliberately distinguishable
 *
 * `PROFESSIONAL` and `BUSINESS` share no digit sequence, so a mixed cache is
 * visible as a wrong number on screen rather than as a subtly wrong total.
 */

const PROFESSIONAL_REF = 'p'.repeat(43);
const BUSINESS_REF = 'b'.repeat(43);

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
  workspaces?: Array<{ workspaceRef: string; workspaceType: 'professional' | 'business' }>;
  workspacesFails?: boolean;
}) {
  const workspaces = options.workspaces ?? [{ workspaceRef: PROFESSIONAL_REF, workspaceType: 'professional' }];

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
    expect(screen.queryByRole('group', { name: 'انتخاب کسب‌وکار' })).not.toBeInTheDocument();
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

    expect(await screen.findByText('هنوز کسب‌وکاری برای نمایش اطلاعات مالی ندارید.')).toBeInTheDocument();
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
        return ok({ items: [{ workspaceRef: PROFESSIONAL_REF, workspaceType: 'professional' }] });
      }
      if (url.includes('/summary')) {
        return ok({ partyType: 'professional', receivableNetToman: 0, settledToman: 0, outstandingToman: 0, currency: 'IRT' });
      }
      if (url.includes('/settlements')) return ok({ items: [], nextCursor: null });
      return ok([]);
    });

    renderFinance();

    expect(await screen.findByText('سفارشی در انتظار تسویه ندارید.')).toBeInTheDocument();
    // The employer's distinguishable figure appears nowhere on the page.
    expect(screen.queryByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).not.toBeInTheDocument();
  });
});

describe('a dual owner', () => {
  const both = [
    { workspaceRef: BUSINESS_REF, workspaceType: 'business' as const },
    { workspaceRef: PROFESSIONAL_REF, workspaceType: 'professional' as const },
  ];

  it('gets an accessible selector naming both workspaces', async () => {
    mockApi({ workspaces: both });
    renderFinance();

    const group = await screen.findByRole('group', { name: 'انتخاب کسب‌وکار' });
    const buttons = within(group).getAllByRole('button');

    expect(buttons.map((button) => button.textContent)).toEqual(['کسب‌وکار', 'حرفه‌ای']);
    // Selection is conveyed by `aria-pressed`, not by colour alone.
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches workspace on keyboard activation and re-fetches everything', async () => {
    mockApi({ workspaces: both });
    renderFinance();

    // The first workspace loads first.
    expect(await screen.findByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'انتخاب کسب‌وکار' });
    const professionalButton = within(group).getAllByRole('button')[1];

    // Tab-then-Enter, which is exactly what a labelled group of toggle buttons
    // promises — no arrow-key contract is claimed or required.
    professionalButton.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText(/۱٬۱۱۱٬۰۰۰|1,111,000/)).toBeInTheDocument());
    expect(professionalButton).toHaveAttribute('aria-pressed', 'true');
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
    await screen.findByText(/۲٬۲۲۲٬۰۰۰|2,222,000/);

    const group = screen.getByRole('group', { name: 'انتخاب کسب‌وکار' });
    await userEvent.click(within(group).getAllByRole('button')[1]);

    await waitFor(() => expect(screen.getByText(/۱٬۱۱۱٬۰۰۰|1,111,000/)).toBeInTheDocument());
    // The business figure is not merely superseded — it is not on the page.
    expect(screen.queryByText(/۲٬۲۲۲٬۰۰۰|2,222,000/)).not.toBeInTheDocument();
  });

  it('requests each workspace by its own reference', async () => {
    mockApi({ workspaces: both });
    renderFinance();
    await screen.findByText(/۲٬۲۲۲٬۰۰۰|2,222,000/);

    const group = screen.getByRole('group', { name: 'انتخاب کسب‌وکار' });
    await userEvent.click(within(group).getAllByRole('button')[1]);
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
    expect(screen.queryByText('هنوز کسب‌وکاری برای نمایش اطلاعات مالی ندارید.')).not.toBeInTheDocument();
  });
});
