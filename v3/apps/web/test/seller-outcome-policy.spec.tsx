import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProOutcomePolicyPage from '@/app/pro/outcome-policy/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/outcome-policy',
}));

/**
 * The seller's outcome-policy selection — V3.3 `#42b` / #159, ADR-051 §3,
 * design `48_SELLER_OUTCOME_POLICY.md` with its reviewer corrections.
 *
 * ## What these cases are about
 *
 *  1. **The seller picks, never types.** Every group renders exactly the
 *     published members. A numeric or free-text input for a policy term
 *     would only ever produce a request the server rejects.
 *  2. **Fail-closed is a real screen, not an error.** When a narrowed range
 *     no longer contains the selection, new bookings stop — and the screen
 *     has to say that existing bookings are untouched, without blame.
 *  3. **Not enrolled is legitimate.** No warning, no "incomplete setup".
 *  4. **No workspace is pre-selected**, not even when there is one
 *     (`V33-DEC-020`).
 */

const OWNED = {
  workspaceRef: 'o'.repeat(43),
  workspaceType: 'business' as const,
  accessMode: 'owner' as const,
  displayLabel: 'سالن نور',
};

/** A workspace reached only by a finance_read grant — never offered here. */
const GRANTED = {
  workspaceRef: 'g'.repeat(43),
  workspaceType: 'business' as const,
  accessMode: 'finance_read' as const,
  displayLabel: 'سالن دیگران',
};

const POLICY = {
  policyKey: 'standard-outcome',
  displayName: 'شرایط استاندارد',
  allowed: {
    cutoffHours: [6, 12, 48],
    lateCancellationRetention: [
      { kind: 'none' as const },
      { kind: 'percentage_of_collected' as const, basisPoints: 2500 },
      { kind: 'fixed_toman' as const, amountToman: 50_000 },
    ],
    noShowGraceMinutes: [10, 20],
    noShowRetention: [{ kind: 'none' as const }, { kind: 'full_collected' as const }],
  },
};

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    policyKey: POLICY.policyKey,
    displayName: POLICY.displayName,
    selection: {
      cutoffHours: 12,
      lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2500 },
      noShowGraceMinutes: 10,
      noShowRetention: { kind: 'full_collected' },
    },
    assignedAt: '2026-09-15T08:00:00.000Z',
    resolvable: true,
    ...overrides,
  };
}

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string, message: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
}

let sent: Array<{ method: string; url: string; body: Record<string, unknown> }>;

function mockApi(options: {
  workspaces?: unknown[];
  policies?: unknown[];
  assignment?: unknown;
  putRefusal?: { status: number; code: string; message: string };
} = {}) {
  sent = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['professional'], capabilities: ['bc_manage_own_collection_policy'] });
    }
    if (url.includes('/v1/me/provider')) return ok({ id: 'prof-1', displayName: 'نمایه', verificationStatus: 'verified' });

    if (method === 'PUT' && url.includes('/outcome-policy-assignments/')) {
      sent.push({ method, url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (options.putRefusal) return refused(options.putRefusal.status, options.putRefusal.code, options.putRefusal.message);
      return ok({ assignment: assignment() });
    }
    if (url.includes('/v1/me/outcome-policy-assignments/')) {
      return ok({ assignment: options.assignment === undefined ? null : options.assignment });
    }
    if (url.includes('/v1/me/outcome-policies')) return ok({ items: options.policies ?? [POLICY] });
    if (url.includes('/v1/me/finance/workspaces')) return ok({ items: options.workspaces ?? [OWNED] });
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProOutcomePolicyPage />
      </ProProvider>
    </AuthProvider>,
  );
}

async function chooseWorkspace(ref = OWNED.workspaceRef) {
  const chooser = await screen.findByTestId('workspace-chooser');
  const card = chooser.querySelector(`[data-workspace="${ref}"]`) as HTMLElement;
  await userEvent.click(within(card).getByRole('button'));
  return screen.findByTestId('outcome-selection');
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('screen 48 — seller outcome-policy selection', () => {
  it('offers only owned workspaces, never one reached by a finance_read grant', async () => {
    mockApi({ workspaces: [OWNED, GRANTED] });
    renderPage();

    const chooser = await screen.findByTestId('workspace-chooser');
    expect(chooser.querySelector(`[data-workspace="${OWNED.workspaceRef}"]`)).not.toBeNull();
    // A grantee may read that workspace's money; they may not set its policy.
    expect(chooser.querySelector(`[data-workspace="${GRANTED.workspaceRef}"]`)).toBeNull();
  });

  it('pre-selects no workspace, and renders no terms until one is chosen', async () => {
    mockApi();
    renderPage();

    await screen.findByTestId('workspace-chooser');
    // V33-DEC-020: not even when there is exactly one.
    expect(screen.queryByTestId('outcome-selection')).toBeNull();
    expect(screen.getByText(/تا وقتی فضایی انتخاب نشده/)).toBeInTheDocument();
  });

  it('renders exactly the published members, and no input for any policy term', async () => {
    mockApi();
    renderPage();
    const section = await chooseWorkspace();

    const groups = within(section).getByTestId('outcome-selection-groups');
    // Every control in the groups is a radio — no text box, no number spinner.
    const controls = groups.querySelectorAll('input, textarea, select');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of Array.from(controls)) {
      expect((control as HTMLInputElement).type).toBe('radio');
    }

    // The published members, and only those.
    const cutoffs = groups.querySelector('[data-group="cutoffHours"]') as HTMLElement;
    expect(within(cutoffs).getAllByRole('radio')).toHaveLength(POLICY.allowed.cutoffHours.length);
    for (const hours of ['۶', '۱۲', '۴۸']) expect(cutoffs.textContent).toContain(hours);

    const late = groups.querySelector('[data-group="lateCancellationRetention"]') as HTMLElement;
    expect(within(late).getAllByRole('radio')).toHaveLength(3);
    expect(late.textContent).toContain('هیچ مبلغی نگه داشته نمی‌شود');
    expect(late.textContent).toContain('۲۵۰۰ bp');
  });

  it('pre-fills from the current assignment without re-deriving it', async () => {
    mockApi({ assignment: assignment() });
    renderPage();
    const section = await chooseWorkspace();

    const groups = within(section).getByTestId('outcome-selection-groups');
    const cutoffs = groups.querySelector('[data-group="cutoffHours"]') as HTMLElement;
    const checked = within(cutoffs)
      .getAllByRole('radio')
      .filter((r) => (r as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].closest('label')?.textContent).toContain('۱۲');
  });

  it('renders the fail-closed state as a fact, not a fault', async () => {
    mockApi({ assignment: assignment({ resolvable: false }) });
    renderPage();
    const section = await chooseWorkspace();

    const notice = section.querySelector('[data-state="fail-closed"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('رزروهای تازه تا انتخاب دوباره پذیرفته نمی‌شوند');
    // The reassurance is the point: nothing already taken is affected.
    expect(notice.textContent).toContain('دست‌نخورده');
    // The selection is still offered — this is a screen to act on, not an error page.
    expect(within(section).getByTestId('outcome-selection-groups')).toBeInTheDocument();
    for (const blame of ['خطا', 'اشتباه', 'ناقص']) expect(notice.textContent).not.toContain(blame);
  });

  it('renders not-enrolled as legitimate, with no warning language', async () => {
    mockApi({ assignment: null });
    renderPage();
    const section = await chooseWorkspace();

    const notice = section.querySelector('[data-state="not-enrolled"]') as HTMLElement;
    expect(notice.textContent).toContain('مثل گذشته ادامه دارند');
    expect(notice.textContent).toContain('اختیاری');
    for (const alarm of ['هشدار', 'ناقص', 'خطا']) expect(notice.textContent).not.toContain(alarm);
  });

  it('treats nothing-published as its own state, distinct from a read failure', async () => {
    mockApi({ policies: [] });
    renderPage();

    const chooser = await screen.findByTestId('workspace-chooser');
    await userEvent.click(within(chooser.querySelector(`[data-workspace="${OWNED.workspaceRef}"]`) as HTMLElement).getByRole('button'));

    await waitFor(() => expect(screen.getByText(/هنوز هیچ سیاستی برای انتخاب منتشر نشده/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /تلاش/ })).toBeNull();
  });

  it('requires a reason before submitting, and sends the chosen members by value', async () => {
    mockApi({ assignment: assignment() });
    renderPage();
    const section = await chooseWorkspace();

    // Already complete from the current assignment; the reason is still required.
    await userEvent.click(within(section).getByRole('button', { name: 'ثبت انتخاب' }));
    expect(sent).toHaveLength(0);
    expect(within(section).getByText('دلیل را بنویسید.')).toBeInTheDocument();

    await userEvent.type(within(section).getByLabelText(/دلیل این انتخاب/), 'تصمیم سالن');
    await userEvent.click(within(section).getByRole('button', { name: 'ثبت انتخاب' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].body).toEqual({
      policyKey: 'standard-outcome',
      cutoffHours: 12,
      // By value, as the published member — not as an identity string.
      lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2500 },
      noShowGraceMinutes: 10,
      noShowRetention: { kind: 'full_collected' },
      reason: 'تصمیم سالن',
    });
  });

  it('keeps the selection and the typed reason after a refusal', async () => {
    mockApi({
      assignment: assignment(),
      putRefusal: { status: 409, code: 'outcome_policy_assignment_unavailable', message: 'این انتخاب در دسترس نیست.' },
    });
    renderPage();
    const section = await chooseWorkspace();

    await userEvent.type(within(section).getByLabelText(/دلیل این انتخاب/), 'تصمیم سالن');
    await userEvent.click(within(section).getByRole('button', { name: 'ثبت انتخاب' }));

    await waitFor(() => expect(within(section).getByRole('alert')).toHaveTextContent('این انتخاب در دسترس نیست.'));
    expect(within(section).getByLabelText(/دلیل این انتخاب/)).toHaveValue('تصمیم سالن');
    const cutoffs = section.querySelector('[data-group="cutoffHours"]') as HTMLElement;
    expect(within(cutoffs).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
  });

  it('shows the customer-facing consequence only once the selection is complete', async () => {
    mockApi({ assignment: null });
    renderPage();
    const section = await chooseWorkspace();

    // Nothing chosen yet: no consequence, because there is none to state.
    expect(within(section).queryByTestId('customer-consequence')).toBeNull();

    const groups = within(section).getByTestId('outcome-selection-groups');
    await userEvent.click(within(groups.querySelector('[data-group="cutoffHours"]') as HTMLElement).getAllByRole('radio')[1]);
    await userEvent.click(within(groups.querySelector('[data-group="lateCancellationRetention"]') as HTMLElement).getAllByRole('radio')[0]);
    await userEvent.click(within(groups.querySelector('[data-group="noShowGraceMinutes"]') as HTMLElement).getAllByRole('radio')[0]);
    await userEvent.click(within(groups.querySelector('[data-group="noShowRetention"]') as HTMLElement).getAllByRole('radio')[1]);

    const consequence = await within(section).findByTestId('customer-consequence');
    expect(consequence.textContent).toContain('۱۲ ساعت');
    expect(consequence.textContent).toContain('هیچ مبلغی نگه داشته نمی‌شود');
    // And it says plainly that the real wording is the administrator's.
    expect(consequence.textContent).toContain('متنِ دقیقی که مشتری می‌بیند را مدیر منتشر می‌کند');
  });

  it('states that bookings already taken keep their own terms', async () => {
    mockApi({ assignment: assignment() });
    renderPage();
    const section = await chooseWorkspace();
    expect(section.textContent).toContain('با همان شرایطی که زیر آن گرفته شده‌اند پیش می‌روند');
  });
});
