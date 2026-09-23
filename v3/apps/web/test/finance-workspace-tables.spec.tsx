import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancePage from '@/app/finance/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/finance',
}));

/**
 * The finance workspace's tables and marks, against `46_FINANCE_WORKSPACE.md`
 * and `13_PRO_FINANCE.md`. The workspace's state discipline (selection,
 * authority loss, independent sections) is covered by `finance-page.spec.tsx`
 * and `finance-workspaces.spec.tsx` and is unchanged; what is asserted here is
 * how it names and lays out what the server sends.
 */

const REF = 'b'.repeat(43);
const OTHER_REF = 'r'.repeat(43);
const ORDER_ID = '11111111-2222-3333-4444-555555555555';

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

const owner = { workspaceRef: REF, workspaceType: 'business', accessMode: 'owner', displayLabel: 'سالن نور' };
const delegated = { workspaceRef: OTHER_REF, workspaceType: 'business', accessMode: 'finance_read', displayLabel: 'کلینیک آفتاب' };

const batch = (over: Record<string, unknown>) => ({
  id: 's1',
  kind: 'settlement',
  amountToman: 1_500_000,
  currency: 'IRT',
  method: 'bank_transfer',
  reference: null,
  createdAt: '2026-09-01T08:30:00.000Z',
  ...over,
});

function mockApi(opts: { workspaces?: unknown[]; batches?: unknown[]; ledger?: unknown[] } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    if (url.includes('/v1/me/finance/workspaces')) return ok({ items: opts.workspaces ?? [owner] });
    if (url.includes('/summary')) return ok({ partyType: 'business', receivableNetToman: 3_000_000, settledToman: 1_000_000, outstandingToman: 2_000_000, currency: 'IRT' });
    if (url.includes('/funds')) return ok({ pending: 0, disputed: 0, available: 0, reserve: 0, settled: 0, refunded: 0, platformEarned: 0, providerFee: 0, recoveryOut: 0, collected: 0, platformAdvance: 0, recoveredIn: 0, currency: 'IRT' });
    if (url.includes('/outstanding-orders')) return ok([{ orderId: ORDER_ID, outstandingToman: 700_000 }]);
    if (url.includes('/settlements')) return ok({ items: opts.batches ?? [], nextCursor: null });
    if (url.includes('/ledger')) return ok(opts.ledger ?? []);
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

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'access-token', csrfToken: 'test-csrf-token' });
});

describe('the settlement history', () => {
  it('is a real, named table with a labelled cell for every column — a card list on a phone, by the same markup', async () => {
    mockApi({ batches: [batch({ id: 's1' }), batch({ id: 's2', kind: 'reversal', amountToman: 250_000, method: null })] });
    renderFinance();
    const table = await screen.findByRole('table', { name: 'تاریخچه تسویه' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['تاریخ', 'مبلغ (تومان)', 'روش', 'نوع']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + two batches
    // Each body cell repeats its own label — what the phone's card layout prints above its value.
    const cells = within(rows[1]).getAllByRole('cell');
    expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(['تاریخ', 'مبلغ (تومان)', 'روش', 'نوع']);
  });

  it('names a settlement and a reversal in words, with a tone, and shows a neutral word for a kind it does not know', async () => {
    mockApi({
      batches: [
        batch({ id: 's1', kind: 'settlement' }),
        batch({ id: 's2', kind: 'reversal' }),
        batch({ id: 's3', kind: 'chargeback', amountToman: 42_000 }),
      ],
    });
    renderFinance();
    const table = await screen.findByRole('table', { name: 'تاریخچه تسویه' });
    expect(within(table).getByText('تسویه')).toBeInTheDocument();
    expect(within(table).getByText('برگشت تسویه')).toBeInTheDocument();
    expect(within(table).getByText('نامشخص')).toBeInTheDocument();
    expect(table.textContent).not.toContain('chargeback');
  });

  it('sets the payment method as its own left-to-right run, and a dash when there is none', async () => {
    mockApi({ batches: [batch({ id: 's1', method: 'bank_transfer' }), batch({ id: 's2', method: null })] });
    renderFinance();
    const table = await screen.findByRole('table', { name: 'تاریخچه تسویه' });
    const method = within(table).getByText('bank_transfer');
    expect(method.tagName).toBe('SPAN');
    expect(method.className).toContain('method');
    const rows = within(table).getAllByRole('row');
    expect(within(rows[2]).getByText('—')).toBeInTheDocument();
  });

  it('says plainly that there is no history, with no table to read', async () => {
    mockApi({ batches: [] });
    renderFinance();
    expect(await screen.findByText('هنوز تسویه‌ای انجام نشده است.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'تاریخچه تسویه' })).toBeNull();
  });
});

describe('the per-order ledger', () => {
  it('labels each entry by its type, and never calls an unknown entry the seller’s own share', async () => {
    mockApi({
      ledger: [
        { id: 'l1', entryType: 'commission', amountToman: 70_000, currency: 'IRT', commissionRateBp: 1000, referenceType: 'order', createdAt: '2026-09-01T08:30:00.000Z' },
        { id: 'l2', entryType: 'receivable', amountToman: 630_000, currency: 'IRT', commissionRateBp: 1000, referenceType: 'order', createdAt: '2026-09-01T08:30:00.000Z' },
        { id: 'l3', entryType: 'advance', amountToman: 5_000, currency: 'IRT', commissionRateBp: 0, referenceType: 'order', createdAt: '2026-09-01T08:30:00.000Z' },
      ],
    });
    const user = userEvent.setup();
    renderFinance();
    await user.click(await screen.findByRole('button', { name: 'ریز تراکنش' }));
    const table = await screen.findByRole('table', { name: 'ریز تراکنش سفارش' });
    // `DataTable`'s cells are all `role="cell"` (`components/kit.tsx`'s
    // `DataCell` never renders a `<th>`), not `rowheader` — matching the
    // admin/loyalty and checkout/result migrations in #284.
    expect(within(table).getByRole('cell', { name: 'کارمزد پلتفرم' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'سهم شما' })).toBeInTheDocument();
    // The unknown one is neither of those, and is not a raw key.
    expect(within(table).getByRole('cell', { name: 'ردیف دفتر مالی' })).toBeInTheDocument();
    expect(within(table).getAllByRole('cell', { name: 'سهم شما' })).toHaveLength(1);
    expect(table.textContent).not.toContain('advance');
  });
});

describe('the access mark', () => {
  it('is a filled circle for the owner and a hollow square for a delegated read-only grant — shape and words, not colour alone', async () => {
    mockApi({ workspaces: [owner, delegated] });
    renderFinance();
    const group = await screen.findByRole('group', { name: 'کدام فضای مالی؟' });
    const ownerMark = within(group).getByText('دسترسیِ مالکانه').querySelector('[aria-hidden="true"]') as HTMLElement;
    const readMark = within(group).getByText('دسترسیِ فقط‌خواندنیِ واگذارشده').querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(ownerMark.className).toContain('markOwner');
    expect(readMark.className).toContain('markRead');
    expect(ownerMark.className).not.toBe(readMark.className);
  });
});
