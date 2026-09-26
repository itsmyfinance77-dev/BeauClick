/**
 * @jest-environment ./test/ambient-zone-environment.js
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminControlPlanePage from '@/app/admin/commercial/control-plane/page';
import { AuthProvider } from '@/lib/auth-context';
import { ACTIVATION_END_LABEL } from '@/lib/commercial-lifecycle';
import { tokenStorage } from '@/lib/token-storage';
import { withAmbientZone } from './ambient-zone';
import { ADMIN, FAR_PAST, fail, installFakeApi, ok, type Route } from './commercial-fake-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/commercial/control-plane',
}));

/**
 * `/admin/commercial/control-plane`, against `44_ADMIN_CONTROL_PLANE.md`: a
 * legend of three distinct groups that invents no gate state; an enforcement
 * plane whose every command is exactly a reason, with no seller picker and
 * activation that fails closed; and a collection-policy editor with no
 * defaults whose deposit fields exist only in deposit mode.
 */

const CAP = ['bc_manage_commercial_plans'];
const E = `${ADMIN}/booking-credit-enforcement`;

const STATUS = { rolloutState: 'inactive', killSwitchState: 'released', activationGeneration: 0, activatedAt: null, killSwitchChangedAt: null };
const PREVIEW = { rolloutState: 'inactive', killSwitchState: 'released', activationGeneration: 0, eligible: 12, governed: 5, legacyExempt: 4, unresolved: 3, wouldBeRefused: 1 };

const DRAFT = {
  policyKey: 'venue-default',
  version: 1,
  lifecycleState: 'draft',
  collectionMode: 'pay_at_venue',
  deposit: { kind: 'none' },
  contractVersion: 1,
  activationStartsAt: null,
  activationEndsAt: null,
  publishedAt: null,
  retiredAt: null,
};

function routes({
  status = STATUS,
  preview = PREVIEW,
  overrides = [],
}: { status?: object; preview?: object; overrides?: Route[] } = {}): Route[] {
  return [
    ...overrides,
    ['GET', /^\/v1\/admin\/commercial\/booking-credit-enforcement$/, () => ok(status)],
    ['GET', /^\/v1\/admin\/commercial\/booking-credit-enforcement\/preview$/, () => ok(preview)],
    ['POST', /^\/v1\/admin\/commercial\/booking-credit-enforcement\/(transitions|exemptions)$/, () => ok({ affected: 2, skipped: 1 })],
    ['POST', /^\/v1\/admin\/commercial\/booking-credit-enforcement\//, () => ok(status)],
    ['GET', /^\/v1\/admin\/commercial\/collection-policies$/, () => ok({ items: [{ policyKey: 'venue-default', displayName: 'پیش‌فرض محل', createdAt: FAR_PAST }] })],
    ['GET', /^\/v1\/admin\/commercial\/collection-policies\/[^/]+\/versions$/, () => ok({ items: [DRAFT] })],
    ['POST', /^\/v1\/admin\/commercial\/collection-policies\/[^/]+\/versions$/, () => ok({ ...DRAFT, version: 2 })],
  ];
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminControlPlanePage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a platform operator without `bc_manage_commercial_plans`, and reads nothing', async () => {
    const api = installFakeApi(['bc_manage_platform'], routes());
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });
});

describe('the legend', () => {
  it('renders stored, derived and gate states as three distinct groups', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const legend = await screen.findByTestId('lifecycle-legend');
    expect([...legend.querySelectorAll('[data-legend-group]')].map((g) => g.getAttribute('data-legend-group'))).toEqual(['stored', 'derived', 'gates']);
  });

  it('invents no state for the gates the API does not report, and shows the kill switch’s real one', async () => {
    installFakeApi(CAP, routes({ status: { ...STATUS, killSwitchState: 'engaged' } }));
    renderPage();
    const legend = await screen.findByTestId('lifecycle-legend');
    expect(legend.querySelector('[data-gate="legal"]')).toHaveTextContent('این صفحه گزارش نمی‌دهد.');
    expect(legend.querySelector('[data-gate="payment-provider"]')).toHaveTextContent('این صفحه گزارش نمی‌دهد.');
    await waitFor(() => expect(legend.querySelector('[data-gate="kill-switch"]')).toHaveTextContent('درگیر'));
  });
});

describe('the enforcement plane', () => {
  it('shows aggregate counts only — no seller list and no way to name one', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    await waitFor(() => expect(panel.querySelector('[data-count="unresolved"]')).toHaveTextContent('۳'));
    expect(panel.querySelectorAll('[data-count]')).toHaveLength(5);
    expect(within(panel).queryAllByRole('textbox')).toEqual([]);
    expect(within(panel).queryAllByRole('combobox')).toEqual([]);
    expect(within(panel).queryAllByRole('table')).toEqual([]);
  });

  it.each([
    ['مشمول‌کردن فروشندگان دارای اعتبار', 'transitions'],
    ['معاف‌کردن فروشندگان بی‌اعتبار', 'exemptions'],
    ['درگیر کردن توقف اضطراری', 'kill-switch/engage'],
  ])('sends «%s» as exactly a reason, and reports the result', async (label, path) => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    await user.click(await within(panel).findByRole('button', { name: label }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل'), '  بازبینی ماهانه  ');
    await user.click(within(dialog).getByRole('button', { name: label }));

    await waitFor(() => expect(api.sent('POST', `${E}/${path}`)).toHaveLength(1));
    expect(api.sent('POST', `${E}/${path}`)[0].body).toEqual({ reason: 'بازبینی ماهانه' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.writes()).toHaveLength(1);
  });

  it('reports what a set-based command did in counts', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    await user.click(await within(panel).findByRole('button', { name: 'مشمول‌کردن فروشندگان دارای اعتبار' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('دلیل'), 'دلیل');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'مشمول‌کردن فروشندگان دارای اعتبار' }));
    expect(await within(panel).findByText(/۲ فروشنده تغییر کرد، ۱ فروشنده کنار گذاشته شد/)).toBeInTheDocument();
  });

  it('offers only the kill-switch move that applies', async () => {
    installFakeApi(CAP, routes({ status: { ...STATUS, killSwitchState: 'engaged' } }));
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    expect(await within(panel).findByRole('button', { name: 'آزاد کردن توقف اضطراری' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'درگیر کردن توقف اضطراری' })).toBeNull();
  });

  it('keeps activation disabled while any seller is unresolved, and says why', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    const activate = await within(panel).findByRole('button', { name: 'فعال‌سازی سراسری' });
    expect(activate).toBeDisabled();
    const described = document.getElementById(activate.getAttribute('aria-describedby') ?? '');
    expect(described).toHaveTextContent('وضعیت ۳ فروشنده هنوز تعیین نشده است');
  });

  it('allows activation once nobody is unresolved, and offers no activation — and no deactivation — once active', async () => {
    installFakeApi(CAP, routes({ preview: { ...PREVIEW, unresolved: 0 } }));
    const { unmount } = renderPage();
    expect(await within(await screen.findByTestId('enforcement')).findByRole('button', { name: 'فعال‌سازی سراسری' })).toBeEnabled();
    unmount();

    installFakeApi(CAP, routes({ status: { ...STATUS, rolloutState: 'active', activatedAt: FAR_PAST }, preview: { ...PREVIEW, unresolved: 0 } }));
    renderPage();
    const panel = await screen.findByTestId('enforcement');
    await within(panel).findByRole('button', { name: 'درگیر کردن توقف اضطراری' });
    expect(within(panel).queryByRole('button', { name: /فعال‌سازی|غیرفعال/ })).toBeNull();
  });

  it('keeps the dialog on a refused activation, with the server’s counts', async () => {
    installFakeApi(
      CAP,
      routes({
        preview: { ...PREVIEW, unresolved: 0 },
        overrides: [
          [
            'POST',
            /\/activation$/,
            () => fail(409, 'COMMERCIAL_ENFORCEMENT_ACTIVATION_REFUSED', 'فعال‌سازی سراسری ممکن نیست: وضعیت برخی فروشندگان هنوز تعیین نشده است.', { rolloutState: 'inactive', unresolved: 2 }),
          ],
        ],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await within(await screen.findByTestId('enforcement')).findByRole('button', { name: 'فعال‌سازی سراسری' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل'), 'آغاز اعمال');
    await user.click(within(dialog).getByRole('button', { name: 'فعال‌سازی سراسری' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('فعال‌سازی سراسری ممکن نیست');
    expect(alert).toHaveTextContent('unresolved: 2');
    expect(within(dialog).getByLabelText('دلیل')).toHaveValue('آغاز اعمال');
  });
});

describe('the collection policy editor', () => {
  async function openNewDraft() {
    const user = userEvent.setup();
    renderPage();
    const family = await waitFor(() => {
      const el = document.querySelector('[data-family="collection-policies"]') as HTMLElement | null;
      expect(el?.querySelector('[data-version="1"]')).toBeTruthy();
      return el as HTMLElement;
    });
    await user.click(within(family).getByRole('button', { name: 'پیش‌نویس تازه برای venue-default' }));
    return { user, editor: await screen.findByTestId('collection-policy-editor') };
  }

  it('chooses nothing for the administrator and shows no deposit fields until deposit mode', async () => {
    installFakeApi(CAP, routes());
    const { editor } = await openNewDraft();
    for (const radio of within(editor).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.queryByTestId('deposit-rule')).toBeNull();
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
  });

  it('sends `none` as the deposit for a mode without one, and no activation start', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('radio', { name: /پرداخت کامل آنلاین/ }));
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)[0].body).toEqual({
      collectionMode: 'full_payment_online',
      deposit: { kind: 'none' },
      activationEndsAt: null,
      reason: 'دلیل کافی',
    });
  });

  it('shows the deposit rule in deposit mode only', async () => {
    installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('radio', { name: /پرداخت در محل/ }));
    expect(screen.queryByTestId('deposit-rule')).toBeNull();
    await user.click(within(editor).getByRole('radio', { name: /پیش‌پرداخت آنلاین، مانده در محل/ }));
    expect(screen.getByTestId('deposit-rule')).toBeInTheDocument();
  });

  it('drops a deposit typed in deposit mode once another mode is chosen — nothing hidden is sent', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('radio', { name: /پیش‌پرداخت آنلاین، مانده در محل/ }));
    const deposit = screen.getByTestId('deposit-rule');
    await user.click(within(deposit).getByRole('radio', { name: 'مبلغ ثابت' }));
    await user.type(within(deposit).getByLabelText('مبلغ پیش‌پرداخت (تومان)'), '200000');
    await user.click(within(editor).getByRole('radio', { name: /پرداخت در محل/ }));
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)[0].body).toMatchObject({
      collectionMode: 'pay_at_venue',
      deposit: { kind: 'none' },
    });
  });

  it('requires a percentage base with no default, and sends the percentage rule exactly', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('radio', { name: /پیش‌پرداخت آنلاین، مانده در محل/ }));
    const deposit = screen.getByTestId('deposit-rule');
    await user.click(within(deposit).getByRole('radio', { name: 'درصدی از مبلغ' }));
    await user.type(within(deposit).getByLabelText('نرخ (bp، یک تا ۱۰٬۰۰۰)'), '2000');
    await user.type(within(deposit).getByLabelText('کمینه (تومان)'), '50000');
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');

    const base = screen.getByTestId('percentage-base');
    for (const radio of within(base).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();

    await user.click(within(base).getByRole('radio', { name: /مبلغ نهایی سفارش/ }));
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)[0].body).toEqual({
      collectionMode: 'deposit_online_balance_at_venue',
      deposit: { kind: 'percentage', basisPoints: 2000, percentageBase: 'service_total', minimumToman: 50000, maximumToman: null },
      activationEndsAt: null,
      reason: 'دلیل کافی',
    });
  });

  it('refuses a maximum below the minimum before anything is sent', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('radio', { name: /پیش‌پرداخت آنلاین، مانده در محل/ }));
    const deposit = screen.getByTestId('deposit-rule');
    await user.click(within(deposit).getByRole('radio', { name: 'درصدی از مبلغ' }));
    await user.type(within(deposit).getByLabelText('نرخ (bp، یک تا ۱۰٬۰۰۰)'), '2000');
    await user.click(within(screen.getByTestId('percentage-base')).getByRole('radio', { name: /جمع پیش از تعدیل‌ها/ }));
    await user.type(within(deposit).getByLabelText('کمینه (تومان)'), '50000');
    await user.type(within(deposit).getByLabelText('بیشینه (تومان، اختیاری)'), '100');
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');
    expect(within(deposit).getByText('بیشینه نمی‌تواند کمتر از کمینه باشد.')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
    expect(api.writes()).toEqual([]);
  });

  it('says in the publish dialog that existing bookings are unchanged', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const family = await waitFor(() => {
      const el = document.querySelector('[data-family="collection-policies"] [data-version="1"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await user.click(within(family).getByRole('button', { name: 'انتشار نسخهٔ ۱' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/رزروهای موجود تغییری نمی‌کنند/);
  });
});

/*
 * #321. The operator's machine is on UTC; the end typed is still Tehran's
 * wall clock, and a saved draft still opens at the Tehran time it means.
 */
describe('the collection policy’s end is Tehran time, whatever zone the operator is in (#321)', () => {
  withAmbientZone('UTC');

  async function openFamily() {
    const user = userEvent.setup();
    renderPage();
    const family = await waitFor(() => {
      const el = document.querySelector('[data-family="collection-policies"]') as HTMLElement | null;
      expect(el?.querySelector('[data-version="1"]')).toBeTruthy();
      return el as HTMLElement;
    });
    return { user, family };
  }

  it('sends the end typed as the Tehran instant', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, family } = await openFamily();
    await user.click(within(family).getByRole('button', { name: 'پیش‌نویس تازه برای venue-default' }));
    const editor = await screen.findByTestId('collection-policy-editor');
    await user.click(within(editor).getByRole('radio', { name: /پرداخت کامل آنلاین/ }));
    await user.type(within(editor).getByLabelText(ACTIVATION_END_LABEL), '2026-01-01T09:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/collection-policies/venue-default/versions`)[0].body).toMatchObject({ activationEndsAt: '2026-01-01T05:30:00.000Z' });
  });

  it('opens a draft at the Tehran time it was saved with, and saves it back unchanged', async () => {
    const api = installFakeApi(
      CAP,
      routes({
        overrides: [
          ['GET', /^\/v1\/admin\/commercial\/collection-policies\/[^/]+\/versions$/, () => ok({ items: [{ ...DRAFT, activationEndsAt: '2025-12-31T20:30:00.000Z' }] })],
          ['PUT', /^\/v1\/admin\/commercial\/collection-policies\/[^/]+\/versions\/1$/, () => ok(DRAFT)],
        ],
      }),
    );
    const { user, family } = await openFamily();
    await user.click(within(family).getByRole('button', { name: 'ویرایش پیش‌نویس ۱' }));
    const editor = await screen.findByTestId('collection-policy-editor');
    expect(within(editor).getByLabelText(ACTIVATION_END_LABEL)).toHaveValue('2026-01-01T00:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'بدون تغییر زمان');
    await user.click(within(editor).getByRole('button', { name: 'ذخیرهٔ پیش‌نویس' }));
    await waitFor(() => expect(api.sent('PUT', `${ADMIN}/collection-policies/venue-default/versions/1`)).toHaveLength(1));
    expect(api.sent('PUT', `${ADMIN}/collection-policies/venue-default/versions/1`)[0].body).toMatchObject({ activationEndsAt: '2025-12-31T20:30:00.000Z' });
  });
});
