import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminSettlementsPage from '@/app/admin/settlements/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/settlements',
}));

/**
 * `/admin/settlements`, against `17_ADMIN_SETTLEMENTS.md`.
 *
 * This page records money moving between the platform and a seller, and it had
 * no test at all. The case that matters most is the one about WHICH party a
 * settlement is recorded against.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code: 'ERR', message } }) });

const PARTY_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PARTY_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const ORDERS = [
  { orderId: '11111111-aaaa-4aaa-8aaa-111111111111', outstandingToman: 120000 },
  { orderId: '22222222-bbbb-4bbb-8bbb-222222222222', outstandingToman: 80000 },
];

interface Opts {
  totals?: () => Promise<unknown>;
  settle?: () => Promise<unknown>;
  orders?: unknown[];
}

function mockApi(opts: Opts = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities: ['bc_manage_platform'] });
    if (url.includes('/v1/admin/finance/totals')) return opts.totals ? opts.totals() : ok({ commissionToman: 500000, receivableToman: 4500000, orderCount: 12 });
    if (url.includes('/parties/summary')) return ok({ partyType: 'professional', partyId: 'x', receivableNetToman: 900000, settledToman: 700000, outstandingToman: 200000 });
    if (url.includes('/parties/outstanding-orders')) return ok(opts.orders ?? ORDERS);
    if (url.includes('/v1/admin/finance/settlements') && init?.method === 'POST') {
      return opts.settle ? opts.settle() : ok({ id: 's1', amountToman: 200000, createdAt: '2026-09-21T00:00:00.000Z' });
    }
    return ok([]);
  });
}

function calls(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]: [string, { method?: string } | undefined]) => url.includes(fragment) && (!method || init?.method === method),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminSettlementsPage />
    </AuthProvider>,
  );
}

async function lookUp(user: ReturnType<typeof userEvent.setup>, id = PARTY_A) {
  await screen.findByText('کارمزد پلتفرم');
  await user.type(screen.getByLabelText('شناسه'), id);
  await user.click(screen.getByRole('button', { name: 'نمایش وضعیت' }));
  await screen.findByRole('heading', { name: 'سفارش‌های در انتظار تسویه' });
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the platform totals', () => {
  it('shows the three figures', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('کارمزد پلتفرم')).toBeInTheDocument();
    expect(screen.getByText('سهم فروشندگان')).toBeInTheDocument();
    expect(screen.getByText('سفارش‌های پرداخت‌شده')).toBeInTheDocument();
  });

  it('offers a retry when they fail to load — the spec calls this out — and the lookup stays usable', async () => {
    let attempt = 0;
    mockApi({
      totals: () => (++attempt === 1 ? fail(500, 'خطای سرور') : ok({ commissionToman: 1, receivableToman: 2, orderCount: 3 })),
    });
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(screen.getByLabelText('شناسه')).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText('کارمزد پلتفرم')).toBeInTheDocument();
    expect(calls('/v1/admin/finance/totals')).toHaveLength(2);
  });
});

describe('the lookup', () => {
  it('asks for an id rather than sending an empty one', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('کارمزد پلتفرم');
    await user.click(screen.getByRole('button', { name: 'نمایش وضعیت' }));
    expect(await screen.findByText('شناسهٔ متخصص یا کسب‌وکار را وارد کنید.')).toBeInTheDocument();
    expect(calls('/parties/summary')).toHaveLength(0);
  });

  it('shows the party, its three figures and its outstanding orders as a labelled table', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await lookUp(user);
    expect(screen.getByRole('heading', { name: 'وضعیت مالی طرف حساب' })).toBeInTheDocument();
    const party = screen.getByRole('heading', { name: 'وضعیت مالی طرف حساب' }).closest('section') as HTMLElement;
    expect(within(party).getByText('متخصص')).toBeInTheDocument();
    expect(within(party).getByText(PARTY_A)).toHaveAttribute('class', expect.stringContaining('partyId'));
    expect(within(party).getByText('خالص قابل پرداخت')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'سفارش‌های در انتظار تسویه' });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + two orders
    expect(within(table).getByRole('columnheader', { name: 'مبلغ در انتظار' })).toBeInTheDocument();
  });

  it('says so plainly, and offers no settlement panel, when nothing is outstanding', async () => {
    mockApi({ orders: [] });
    const user = userEvent.setup();
    renderPage();
    await lookUp(user);
    expect(screen.getByText('سفارشی در انتظار تسویه برای این طرف حساب وجود ندارد.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ثبت تسویه' })).toBeNull();
  });
});

describe('recording a settlement', () => {
  async function pickBoth(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('checkbox', { name: 'انتخاب سفارش 11111111' }));
    await user.click(screen.getByRole('checkbox', { name: 'انتخاب سفارش 22222222' }));
  }

  it('cannot be started until an order is ticked, and announces the running total', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await lookUp(user);
    const start = screen.getByRole('button', { name: 'ثبت تسویه' });
    expect(start).toBeDisabled();
    await pickBoth(user);
    expect(start).toBeEnabled();
    const total = screen.getByRole('status');
    expect(total).toHaveTextContent('۲ سفارش');
  });

  it('confirms with a summary the dialog is described by — the amount, the party and the warning', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await lookUp(user);
    await pickBoth(user);
    await user.click(screen.getByRole('button', { name: 'ثبت تسویه' }));
    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const summary = document.getElementById(describedBy as string) as HTMLElement;
    expect(summary).toHaveTextContent('۲ سفارشِ متخصص');
    expect(summary).toHaveTextContent(PARTY_A);
    expect(summary).toHaveTextContent('قابل حذف نیست');
    expect(calls('/v1/admin/finance/settlements', 'POST')).toHaveLength(0);
  });

  it('records the settlement against the party that was LOOKED UP, not what the form says by then', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await lookUp(user, PARTY_A);
    await pickBoth(user);

    // The form is still on screen. Retype the id and flip the type.
    const id = screen.getByLabelText('شناسه');
    await user.clear(id);
    await user.type(id, PARTY_B);
    await user.selectOptions(screen.getByLabelText('نوع'), 'business');

    await user.click(screen.getByRole('button', { name: 'ثبت تسویه' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(PARTY_A);
    expect(dialog).not.toHaveTextContent(PARTY_B);
    await user.click(within(dialog).getByRole('button', { name: 'ثبت کن' }));

    await waitFor(() => expect(calls('/v1/admin/finance/settlements', 'POST')).toHaveLength(1));
    const body = JSON.parse(calls('/v1/admin/finance/settlements', 'POST')[0][1].body);
    expect(body.partyId).toBe(PARTY_A);
    expect(body.partyType).toBe('professional');
    expect(body.orderIds).toEqual(ORDERS.map((o) => o.orderId));
  });

  it('reports the recorded amount, clears the selection and re-reads the server figures for the same party', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await lookUp(user, PARTY_A);
    await pickBoth(user);
    await user.type(screen.getByLabelText('روش پرداخت'), 'انتقال بانکی');
    await user.click(screen.getByRole('button', { name: 'ثبت تسویه' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'ثبت کن' }));

    expect(await screen.findByText(/تسویه به مبلغ .* ثبت شد/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('روش پرداخت')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'ثبت تسویه' })).toBeDisabled();
    // Once for the lookup, once for the refresh — both for party A.
    await waitFor(() => expect(calls('/parties/summary')).toHaveLength(2));
    expect(calls('/parties/summary').every(([url]: [string]) => url.includes(PARTY_A))).toBe(true);
    expect(calls('/v1/admin/finance/totals').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the server’s reason when it refuses, closes the dialog, and keeps the selection', async () => {
    mockApi({ settle: () => fail(409, 'سفارش قبلاً تسویه شده است.') });
    const user = userEvent.setup();
    renderPage();
    await lookUp(user);
    await pickBoth(user);
    await user.click(screen.getByRole('button', { name: 'ثبت تسویه' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'ثبت کن' }));

    expect(await screen.findByText('سفارش قبلاً تسویه شده است.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('checkbox', { name: 'انتخاب سفارش 11111111' })).toBeChecked();
  });
});
