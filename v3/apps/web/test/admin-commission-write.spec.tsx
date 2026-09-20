import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminCommissionPoliciesPage from '@/app/admin/commercial/commission-policies/page';
import { ruleBodyFor } from '@/components/commission-rule-editor';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/commercial/commission-policies',
}));

/**
 * The commission policy WRITE surface — V3.3 `#43b-1` / #173, story #207,
 * ADR-052 §1, design `50_ADMIN_COMMISSION_POLICY.md` §2–§4.
 *
 * ## The three properties these cases exist for
 *
 *  1. **"Absent, not disabled" is a correctness rule.** The DTO says "left
 *     out is the only way to say absent -- there is no sentinel", and the
 *     service's shape check plus the database's CHECK matrix refuse anything
 *     the four kinds do not name. A greyed input that still submits produces
 *     a request the server refuses; an absent one cannot. So the assertions
 *     are on the REQUEST BODY's keys, not only on the DOM.
 *  2. **No refusal may clear the form.** Four codes reach this screen. A
 *     conflict means somebody else moved first; retyping a paragraph of
 *     justification is the wrong penalty for that.
 *  3. **A published version has no edit affordance at all**, not even a
 *     disabled one.
 */

const POLICY = {
  policyKey: 'booking-commission-standard',
  component: 'booking_commission' as const,
  displayName: 'کارمزد نوبت',
  createdAt: '2026-09-01T10:00:00.000Z',
};

function version(o: Record<string, unknown> = {}) {
  return {
    policyKey: POLICY.policyKey,
    version: 1,
    lifecycleState: 'draft',
    ruleKind: 'percentage',
    basisPoints: 750,
    fixedToman: null,
    base: 'platform_collected_amount',
    arithmeticVersion: 1,
    activationStartsAt: null,
    activationEndsAt: null,
    publishedAt: null,
    retiredAt: null,
    createdAt: '2026-09-09T08:00:00.000Z',
    ...o,
  };
}

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message } }),
  });
}

/** Every mutating request this screen made, in order. */
let sent: Array<{ method: string; url: string; body: Record<string, unknown> }>;

function mockApi(options: { versions?: unknown[]; policies?: unknown[]; mutationRefusal?: { status: number; code: string; message: string } } = {}) {
  sent = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['admin'], capabilities: ['bc_manage_commercial_plans'] });
    }

    if (method !== 'GET') {
      sent.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (options.mutationRefusal) {
        const r = options.mutationRefusal;
        return refused(r.status, r.code, r.message);
      }
      return ok(version());
    }

    if (/commission-policies\/[^/]+\/versions/.test(url)) return ok({ items: options.versions ?? [] });
    if (url.includes('/v1/admin/commercial/commission-policies')) return ok({ items: options.policies ?? [POLICY] });
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminCommissionPoliciesPage />
    </AuthProvider>,
  );
}

async function openNewDraft() {
  const grid = await screen.findByTestId('commission-components');
  const card = grid.querySelector('[data-component="booking_commission"]') as HTMLElement;
  await userEvent.click(within(card).getByRole('button', { name: 'پیش‌نویسِ تازه' }));
  return screen.findByTestId('commission-rule-editor');
}

/**
 * Picks a rule shape by its RADIO, not by label text: the shape «مبلغ ثابت»
 * and the amount input «مبلغ ثابت (تومان)» share a name, and a label query
 * would match both once the input exists.
 */
async function chooseShape(editor: HTMLElement, label: string) {
  await userEvent.click(within(editor).getByRole('radio', { name: label }));
}

/** The amount and rate inputs, addressed by their full labels. */
const amountInput = (editor: HTMLElement) => within(editor).getByLabelText('مبلغ ثابت (تومان)');
const rateInput = (editor: HTMLElement) => within(editor).getByLabelText('نرخ (بر حسب bp)');
const queryAmount = (editor: HTMLElement) => within(editor).queryByLabelText('مبلغ ثابت (تومان)');
const queryRate = (editor: HTMLElement) => within(editor).queryByLabelText('نرخ (بر حسب bp)');

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('screen 50b — the commission policy write surface', () => {
  describe('the shape decides which fields exist', () => {
    it('omits every field the shape does not own from the REQUEST BODY, rather than nulling it', () => {
      // The unit the DTO's contract actually rests on. `zero` must not carry
      // a rate even if one was typed before the shape changed.
      const typed = { basisPoints: '750', fixedToman: '25000', base: 'service_total' as const };

      expect(ruleBodyFor('zero', typed)).toEqual({ ruleKind: 'zero' });
      expect(Object.keys(ruleBodyFor('zero', typed))).toEqual(['ruleKind']);

      expect(ruleBodyFor('percentage', typed)).toEqual({ ruleKind: 'percentage', basisPoints: 750, base: 'service_total' });
      expect('fixedToman' in ruleBodyFor('percentage', typed)).toBe(false);

      expect(ruleBodyFor('fixed', typed)).toEqual({ ruleKind: 'fixed', fixedToman: 25000 });
      expect('base' in ruleBodyFor('fixed', typed)).toBe(false);
      expect('basisPoints' in ruleBodyFor('fixed', typed)).toBe(false);

      expect(ruleBodyFor('hybrid', typed)).toEqual({ ruleKind: 'hybrid', basisPoints: 750, fixedToman: 25000, base: 'service_total' });
    });

    it('renders only the current shape’s inputs — the others are absent from the DOM, not disabled', async () => {
      mockApi();
      renderPage();
      const editor = await openNewDraft();

      // `zero` owns nothing.
      expect(queryRate(editor)).toBeNull();
      expect(queryAmount(editor)).toBeNull();
      expect(within(editor).queryByText('نرخ بر چه مبنایی؟')).toBeNull();

      await chooseShape(editor, 'درصدی');
      expect(rateInput(editor)).toBeInTheDocument();
      expect(within(editor).getByText('نرخ بر چه مبنایی؟')).toBeInTheDocument();
      // Absent, not present-and-disabled — the distinction the DTO requires.
      expect(queryAmount(editor)).toBeNull();

      await chooseShape(editor, 'مبلغ ثابت');
      expect(amountInput(editor)).toBeInTheDocument();
      expect(queryRate(editor)).toBeNull();
      expect(within(editor).queryByText('نرخ بر چه مبنایی؟')).toBeNull();

      await chooseShape(editor, 'ترکیبی');
      expect(amountInput(editor)).toBeInTheDocument();
      expect(rateInput(editor)).toBeInTheDocument();
      expect(within(editor).getByText('نرخ بر چه مبنایی؟')).toBeInTheDocument();
    });

    it('moves focus deliberately when the shape change removes the focused field', async () => {
      mockApi();
      renderPage();
      const editor = await openNewDraft();

      await chooseShape(editor, 'درصدی');
      const rate = rateInput(editor);
      rate.focus();
      expect(document.activeElement).toBe(rate);

      // `fixed` does not own the rate field, so it is removed. Focus must not
      // fall to <body>.
      await chooseShape(editor, 'مبلغ ثابت');
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement).toBe(amountInput(editor));
    });

    it('pre-selects neither base, and refuses to submit until one is chosen', async () => {
      mockApi();
      renderPage();
      const editor = await openNewDraft();
      await chooseShape(editor, 'درصدی');

      const bases = within(editor).getAllByRole('radio', { name: /مبلغی که سکو|مبلغ کلِ خدمت/ });
      expect(bases).toHaveLength(2);
      // Neither base radio is checked on a fresh draft.
      expect(bases.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);

      await userEvent.type(rateInput(editor), '750');
      await userEvent.type(within(editor).getByLabelText(/دلیل/), 'آزمون');
      await userEvent.click(within(editor).getByRole('button', { name: 'ثبتِ پیش‌نویس' }));

      // Stopped client-side, and said why.
      expect(sent).toHaveLength(0);
      expect(within(editor).getByText(/هیچ‌کدام پیش‌فرض نیست/)).toBeInTheDocument();
    });
  });

  describe('refusals', () => {
    it.each([
      [409, 'COMMERCIAL_ACTIVATION_OVERLAP', 'بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد.'],
      [409, 'COMMERCIAL_LIFECYCLE_CONFLICT', 'وضعیت این نسخه اجازه این تغییر را نمی‌دهد.'],
      [422, 'COMMERCIAL_TERMS_INVALID', 'شرایط واردشده معتبر نیست.'],
    ])('leaves the draft and the typed reason intact after %s %s', async (status, code, message) => {
      mockApi({ mutationRefusal: { status, code, message } });
      renderPage();
      const editor = await openNewDraft();

      await chooseShape(editor, 'مبلغ ثابت');
      await userEvent.type(amountInput(editor), '25000');
      await userEvent.type(within(editor).getByLabelText(/دلیل/), 'دلیلِ نسبتاً بلندِ آزمون');
      await userEvent.click(within(editor).getByRole('button', { name: 'ثبتِ پیش‌نویس' }));

      await waitFor(() => expect(within(editor).getByRole('alert')).toHaveTextContent(message));

      // Nothing was cleared: the editor is still open, still on `fixed`, with
      // the amount and the reason exactly as typed.
      expect(screen.getByTestId('commission-rule-editor')).toBeInTheDocument();
      expect(amountInput(editor)).toHaveValue(25000);
      expect(within(editor).getByLabelText(/دلیل/)).toHaveValue('دلیلِ نسبتاً بلندِ آزمون');
    });

    it('refuses an empty reason before a request is sent', async () => {
      mockApi();
      renderPage();
      const editor = await openNewDraft();

      await userEvent.click(within(editor).getByRole('button', { name: 'ثبتِ پیش‌نویس' }));

      expect(sent).toHaveLength(0);
      expect(within(editor).getByText('دلیل را بنویسید.')).toBeInTheDocument();
    });
  });

  describe('lifecycle controls', () => {
    it('gives a published row retire and nothing else, and a retired row nothing at all', async () => {
      mockApi({
        versions: [
          version({ version: 1, lifecycleState: 'published', publishedAt: '2026-09-10T08:00:00.000Z' }),
          version({ version: 2, lifecycleState: 'retired', publishedAt: '2026-09-05T08:00:00.000Z', retiredAt: '2026-09-09T08:00:00.000Z' }),
          version({ version: 3, lifecycleState: 'draft' }),
        ],
      });
      renderPage();

      const table = await screen.findByRole('table');
      const rowFor = (v: number) => table.querySelector(`[data-version="${v}"]`) as HTMLElement;

      const published = within(rowFor(1)).getAllByRole('button');
      expect(published.map((b) => b.textContent)).toEqual(['بازنشستگی']);
      // Not even a disabled edit control.
      expect(within(rowFor(1)).queryByRole('button', { name: 'ویرایش' })).toBeNull();

      expect(within(rowFor(2)).queryAllByRole('button')).toHaveLength(0);

      expect(within(rowFor(3)).getAllByRole('button').map((b) => b.textContent)).toEqual(['ویرایش', 'انتشار', 'دور انداختن']);
    });

    it('publishes only after a reason, and says the instant is the server’s', async () => {
      mockApi({ versions: [version({ version: 1, lifecycleState: 'draft' })] });
      renderPage();

      const table = await screen.findByRole('table');
      await userEvent.click(within(table).getByRole('button', { name: 'انتشار' }));

      const dialog = await screen.findByRole('dialog');
      // No date control of any kind, and the copy says why.
      expect(within(dialog).queryByRole('textbox', { name: /تاریخ/ })).toBeNull();
      expect(dialog.querySelectorAll('input[type="date"], input[type="datetime-local"]')).toHaveLength(0);
      expect(dialog.textContent).toContain('لحظهٔ فعال‌سازی را سرور تعیین می‌کند');

      const confirm = within(dialog).getByRole('button', { name: 'انتشار' });
      expect(confirm).toBeDisabled();

      await userEvent.type(within(dialog).getByLabelText('دلیل'), 'تصویبِ کمیته');
      expect(confirm).toBeEnabled();
      await userEvent.click(confirm);

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].method).toBe('POST');
      expect(sent[0].url).toContain('/versions/1/publish');
      expect(sent[0].body).toEqual({ reason: 'تصویبِ کمیته' });
    });

    it('keeps the confirmation open with its reason after a refusal', async () => {
      mockApi({
        versions: [version({ version: 1, lifecycleState: 'draft' })],
        mutationRefusal: { status: 409, code: 'COMMERCIAL_ACTIVATION_OVERLAP', message: 'بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد.' },
      });
      renderPage();

      const table = await screen.findByRole('table');
      await userEvent.click(within(table).getByRole('button', { name: 'انتشار' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.type(within(dialog).getByLabelText('دلیل'), 'تصویبِ کمیته');
      await userEvent.click(within(dialog).getByRole('button', { name: 'انتشار' }));

      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('هم‌پوشانی'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('دلیل')).toHaveValue('تصویبِ کمیته');
    });
  });

  it('offers to create a policy for a component that has none, and publishes nothing by doing so', async () => {
    mockApi({ policies: [] });
    renderPage();

    const grid = await screen.findByTestId('commission-components');
    const card = grid.querySelector('[data-component="acquisition"]') as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'ساختِ سیاست' }));

    const editor = await screen.findByTestId('commission-rule-editor');
    expect(screen.getByText(/ساختِ سیاست چیزی را منتشر نمی‌کند/)).toBeInTheDocument();

    await userEvent.type(within(editor).getByLabelText(/دلیل/), 'راه‌اندازی');
    await userEvent.click(within(editor).getByRole('button', { name: 'ساختِ سیاست' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe('POST');
    expect(sent[0].body).toMatchObject({ component: 'acquisition', reason: 'راه‌اندازی' });
    // The key is derived, never typed.
    expect(sent[0].body.policyKey).toBe('acquisition-standard');
  });
});
