import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminManualRefundsPage from '@/app/admin/refunds/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/refunds',
}));

/**
 * DEMO BRANCH ONLY — F-10: the administrator's manual-refund execution screen.
 * The claim is confirmed first (it must precede any transfer), an executed
 * outcome needs the transfer reference, the server's refusal is shown, and a
 * legacy (untracked) refund says it is never superseded.
 */
const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const OPEN = {
  refundId: 'r1',
  orderId: 'o1',
  amountToman: 300000,
  status: 'manual_required',
  manualTracked: true,
  reason: 'لغو از سوی متخصص',
  requestedAt: '2026-09-27T10:00:00.000Z',
  supersededAt: null,
  executions: [] as unknown[],
};
const CLAIMED = { ...OPEN, executions: [{ executionId: 'e1', state: 'claimed', claimedAt: '2026-09-27T10:05:00.000Z', resolvedAt: null, externalReference: null, note: null }] };

let sent: Array<{ url: string; body: unknown }>;
function mock(rows: unknown[][], opts: { claimFails?: boolean; capabilities?: string[] } = {}) {
  sent = [];
  let reads = 0;
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['administrator'], capabilities: opts.capabilities ?? ['bc_execute_manual_refunds'] });
    if (method === 'POST') {
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/claim') && opts.claimFails) return fail(409, 'REFUND_NOT_CLAIMABLE', 'این بازپرداخت در وضعیتی نیست که بتوان اجرای دستی آن را شروع کرد.');
      return ok({ executionId: 'e1', state: 'claimed', refundStatus: 'succeeded' });
    }
    if (url.includes('/v1/admin/refunds/manual')) return ok(rows[Math.min(reads++, rows.length - 1)]);
    return ok([]);
  });
}
const renderPage = () =>
  render(
    <AuthProvider>
      <AdminManualRefundsPage />
    </AuthProvider>,
  );

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 't', csrfToken: 'c' });
});

describe('admin manual refunds (demo F-10)', () => {
  it('states the synthetic limit and that the claim must precede any transfer; nothing is sent before confirming', async () => {
    mock([[OPEN], [CLAIMED]]);
    renderPage();
    expect(await screen.findByText(/هیچ انتقال وجه واقعی انجام نمی‌شود/)).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('manual-claim'));
    expect(screen.getByText(/پیش از هر انتقال وجه انجام شود/)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'ثبت شروع اجرا' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toContain('/v1/admin/refunds/manual/r1/claim');
    expect(await screen.findByText(/اجرا شروع شده/)).toBeInTheDocument();
  });

  it('an executed outcome needs the transfer reference; the resolve sends outcome + reference', async () => {
    mock([[CLAIMED]]);
    renderPage();
    const card = (await screen.findByText(/اجرا شروع شده/)).closest('[data-refund]') as HTMLElement;
    await userEvent.selectOptions(within(card).getByLabelText('نتیجهٔ اجرا'), 'executed');
    const submit = within(card).getByTestId('manual-resolve');
    expect(submit).toBeDisabled();
    await userEvent.type(within(card).getByLabelText('شناسهٔ پیگیری انتقال'), 'SIM-1');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: expect.stringContaining('/executions/e1/resolve'), body: { outcome: 'executed', externalReference: 'SIM-1' } });
  });

  it('shows the server refusal in its own words (e.g. the customer already rescheduled)', async () => {
    mock([[OPEN]], { claimFails: true });
    renderPage();
    await userEvent.click(await screen.findByTestId('manual-claim'));
    await userEvent.click(screen.getByRole('button', { name: 'ثبت شروع اجرا' }));
    expect(await screen.findByText(/در وضعیتی نیست/)).toBeInTheDocument();
  });

  it('a legacy (untracked) manual refund says it is never superseded', async () => {
    mock([[{ ...OPEN, manualTracked: false }]]);
    renderPage();
    expect(await screen.findByText(/هرگز با نوبت تازه جایگزین نمی‌شود/)).toBeInTheDocument();
  });

  it('refuses an administrator session without the capability (no list request)', async () => {
    mock([[OPEN]], { capabilities: ['bc_manage_platform'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/v1/admin/refunds/manual'))).toBe(false);
  });
});
