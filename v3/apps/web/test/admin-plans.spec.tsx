import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPlansPage from '@/app/admin/commercial/plans/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import { ADMIN, FAR_PAST, fail, installFakeApi, ok, type Route } from './commercial-fake-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/commercial/plans',
}));

/**
 * `/admin/commercial/plans`, against `40_ADMIN_COMMERCIAL_CATALOGUE.md`:
 * integer-only schedules whose tiers are checked by the server's own
 * validator before sending, a closed purpose chosen with no default, and —
 * since the schedule reads began returning each version's id (#271) — plan
 * versions that can be newly drafted against a schedule version the
 * administrator picks.
 */

const CAP = ['bc_manage_commercial_plans'];
/** The schedule version the existing plan draft already points at. */
const SCHEDULE_ID = '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
/** A second one, which only the picker can reach (#271). */
const SCHEDULE_V2_ID = '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0002';

const scheduleV = (over: object) => ({
  id: SCHEDULE_ID,
  scheduleKey: 'seller-price',
  displayName: 'قیمت فروشنده',
  currency: 'IRT',
  minPurchaseQuantity: 1,
  maxPurchaseQuantity: 1,
  activationStartsAt: FAR_PAST,
  activationEndsAt: null,
  publishedAt: FAR_PAST,
  retiredAt: null,
  ...over,
});
const planV = (over: object) => ({
  planKey: 'starter',
  displayName: 'پایه',
  billingTermDays: 30,
  includedBookingCredits: 20,
  staffSeats: 2,
  includedLocations: 1,
  capabilityKeys: ['calendar'],
  priceScheduleVersionId: SCHEDULE_ID,
  bookingCreditScheduleKey: null,
  autoAssignable: false,
  activationStartsAt: FAR_PAST,
  activationEndsAt: null,
  publishedAt: FAR_PAST,
  retiredAt: null,
  ...over,
});

function routes(overrides: Route[] = []): Route[] {
  return [
    ...overrides,
    ['GET', /^\/v1\/admin\/commercial\/price-schedules$/, () =>
      ok({ items: [{ scheduleKey: 'seller-price', purpose: 'seller_plan', createdAt: FAR_PAST }, { scheduleKey: 'credit-pack', purpose: 'booking_credit', createdAt: FAR_PAST }] })],
    ['GET', /^\/v1\/admin\/commercial\/price-schedules\/seller-price\/versions$/, () =>
      ok({
        items: [
          scheduleV({ version: 1, lifecycleState: 'published' }),
          scheduleV({ id: SCHEDULE_V2_ID, version: 2, lifecycleState: 'draft', publishedAt: null }),
        ],
      })],
    ['GET', /^\/v1\/admin\/commercial\/price-schedules\/credit-pack\/versions$/, () => ok({ items: [] })],
    ['GET', /^\/v1\/admin\/commercial\/price-schedules\/seller-price\/versions\/(\d+)$/, (m) =>
      ok({ ...scheduleV({ version: Number(m[1]), lifecycleState: m[1] === '2' ? 'draft' : 'published' }), uiPresetQuantities: [], tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 0 }] })],
    ['POST', /^\/v1\/admin\/commercial\/price-schedules\/[^/]+\/versions$/, () => ok(scheduleV({ version: 3, lifecycleState: 'draft' }))],
    ['PUT', /^\/v1\/admin\/commercial\/price-schedules\/[^/]+\/versions\/\d+$/, () => ok(scheduleV({ version: 2, lifecycleState: 'draft' }))],
    ['POST', /^\/v1\/admin\/commercial\/price-schedules$/, () => ok({ scheduleKey: 'x', purpose: 'seller_plan', createdAt: FAR_PAST })],
    ['GET', /^\/v1\/admin\/commercial\/plans$/, () => ok({ items: [{ planKey: 'starter', createdAt: FAR_PAST }] })],
    ['GET', /^\/v1\/admin\/commercial\/plans\/starter\/versions$/, () =>
      ok({ items: [planV({ version: 1, lifecycleState: 'published', autoAssignable: true }), planV({ version: 2, lifecycleState: 'draft', publishedAt: null })] })],
    ['POST', /^\/v1\/admin\/commercial\/plans\/[^/]+\/versions$/, () => ok(planV({ version: 3, lifecycleState: 'draft', publishedAt: null }))],
    ['PUT', /^\/v1\/admin\/commercial\/plans\/[^/]+\/versions\/\d+$/, () => ok(planV({ version: 2, lifecycleState: 'draft' }))],
  ];
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminPlansPage />
    </AuthProvider>,
  );
}

const family = (id: string) => document.querySelector(`[data-family="${id}"]`) as HTMLElement;

async function waitForRow(familyId: string, key: string, version: number) {
  await waitFor(() => expect(family(familyId)?.querySelector(`[data-key="${key}"] [data-version="${version}"]`)).toBeTruthy());
  return family(familyId).querySelector(`[data-key="${key}"] [data-version="${version}"]`) as HTMLElement;
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

describe('plans (#271)', () => {
  /*
   * The capability #271 unblocked. Before it, the only schedule version id
   * anywhere in a read was the one an existing plan version happened to carry,
   * so a new draft could not name a schedule nobody had used yet — and the page
   * refused to offer one at all rather than offer a wrong list.
   */
  it('offers a new plan draft, listing every schedule version with the state it is in', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await waitForRow('price-schedules', 'seller-price', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    const picker = within(editor).getByLabelText('نسخهٔ جدول قیمت');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'انتخاب کنید',
      'seller-price — نسخهٔ ۱ — قیمت فروشنده (منتشرشده)',
      'seller-price — نسخهٔ ۲ — قیمت فروشنده (پیش‌نویس)',
    ]);
    /*
     * Including the draft. `createPlanVersionDraft` checks only that the id
     * EXISTS, so a narrower list here would refuse something the server allows;
     * the state travels with each option instead.
     */
    expect(picker).toHaveValue('');
  });

  it('will not send a new draft until a schedule version is picked, then sends the one picked', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await waitForRow('price-schedules', 'seller-price', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    // Everything else valid, so the unpicked schedule is the ONLY thing holding it.
    await user.type(within(editor).getByLabelText('نام نمایشی'), 'حرفه‌ای');
    await user.type(within(editor).getByLabelText('اعتبار رزرو همراه طرح'), '50');
    await user.type(within(editor).getByLabelText('جای کارمند'), '5');
    await user.type(within(editor).getByLabelText('شعبه'), '2');
    await user.click(within(editor).getByRole('radio', { name: 'خیر' }));
    await user.type(within(editor).getByLabelText('شروع فعال‌سازی'), '2026-11-01T09:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'طرح تازه');
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();

    // The version the existing plan does NOT point at, so only the picker could have supplied it.
    await user.selectOptions(within(editor).getByLabelText('نسخهٔ جدول قیمت'), SCHEDULE_V2_ID);
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));

    await waitFor(() => expect(api.sent('POST', `${ADMIN}/plans/starter/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/plans/starter/versions`)[0].body).toEqual({
      displayName: 'حرفه‌ای',
      billingTermDays: null,
      includedBookingCredits: 50,
      staffSeats: 5,
      includedLocations: 2,
      capabilityKeys: [],
      priceScheduleVersionId: SCHEDULE_V2_ID,
      bookingCreditScheduleKey: null,
      autoAssignable: false,
      activationStartsAt: new Date('2026-11-01T09:00').toISOString(),
      activationEndsAt: null,
      reason: 'طرح تازه',
    });
  });

  /*
   * The family reads every schedule key's versions on mount, so the complete
   * list is normally there first. These two cover what the picker says when it
   * is not, because a SHORT list looks exactly like a complete one.
   */
  it('says the list is incomplete when a schedule key has not reported, rather than offering a partial catalogue as the whole', async () => {
    installFakeApi(CAP, [
      // `credit-pack` answers; `seller-price` does not. `onVersions` fires only
      // on success, so this is the same state a still-in-flight read leaves.
      ['GET', /^\/v1\/admin\/commercial\/price-schedules\/seller-price\/versions$/, () => fail(500, 'INTERNAL_ERROR', 'نسخه‌ها بارگذاری نشد.')],
      ['GET', /^\/v1\/admin\/commercial\/price-schedules\/credit-pack\/versions$/, () =>
        ok({ items: [scheduleV({ id: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0011', scheduleKey: 'credit-pack', version: 1, lifecycleState: 'published' })] })],
      ...routes(),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');
    const picker = within(editor).getByLabelText('نسخهٔ جدول قیمت');

    // One real option is loaded, so this is NOT the empty case.
    expect(within(picker).getAllByRole('option')).toHaveLength(2);
    expect(editor).toHaveTextContent('فهرست نسخه‌ها کامل نیست');
    // And it does not tell the administrator to "open" a section that reads itself.
    expect(editor.textContent).not.toContain('را باز کنید');
  });

  /*
   * The other half of the same distinction, and the one a mutation caught me
   * missing: dropping the load guard altogether passed every test, because
   * `every` over an empty array is `true`. An unread `schedules` would then be
   * reported as a complete, empty catalogue. The keys read failing produces
   * that state durably, where the initial-load window does not.
   */
  it('does not call an unread schedule list empty when the keys read failed', async () => {
    installFakeApi(CAP, [
      ['GET', /^\/v1\/admin\/commercial\/price-schedules$/, () => fail(500, 'INTERNAL_ERROR', 'فهرست بارگذاری نشد.')],
      ...routes(),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    await waitFor(() => expect(editor).toHaveTextContent('فهرست نسخه‌ها کامل نیست'));
    // «ساخته نشده» would assert a fact about a list nobody managed to read.
    expect(editor.textContent).not.toContain('ساخته نشده است');
  });

  /*
   * A platform with no price schedules at all. `schedules.length > 0` as the
   * guard would have made this state unreachable — `complete` false forever,
   * and the administrator told the list was incomplete when it was complete and
   * empty. The keys read returning `[]` is a fact; not having read it yet is
   * not, and only `schedulesLoaded` separates them.
   */
  it('says none has been made on a platform with no schedule keys at all, and asks for none', async () => {
    const api = installFakeApi(CAP, [
      ['GET', /^\/v1\/admin\/commercial\/price-schedules$/, () => ok({ items: [] })],
      ...routes(),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    await waitFor(() => expect(editor).toHaveTextContent('هنوز هیچ نسخهٔ جدول قیمتی ساخته نشده است'));
    expect(editor.textContent).not.toContain('فهرست نسخه‌ها کامل نیست');
    expect(within(within(editor).getByLabelText('نسخهٔ جدول قیمت')).getAllByRole('option')).toHaveLength(1);
    // No key to ask about, so no versions read was made for one.
    expect(api.calls.filter((c) => /\/price-schedules\/[^/]+\/versions$/.test(c.path))).toEqual([]);
  });

  it('says none has been made when every key reported and there are none, not that none was loaded', async () => {
    installFakeApi(CAP, [
      ['GET', /^\/v1\/admin\/commercial\/price-schedules\/seller-price\/versions$/, () => ok({ items: [] })],
      ['GET', /^\/v1\/admin\/commercial\/price-schedules\/credit-pack\/versions$/, () => ok({ items: [] })],
      ...routes(),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitForRow('plans', 'starter', 2);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    await waitFor(() => expect(editor).toHaveTextContent('هنوز هیچ نسخهٔ جدول قیمتی ساخته نشده است'));
    expect(editor.textContent).not.toContain('فهرست نسخه‌ها کامل نیست');
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
  });

  it('pre-selects no schedule version, even when only one exists', async () => {
    installFakeApi(CAP, [
      ['GET', /^\/v1\/admin\/commercial\/price-schedules\/seller-price\/versions$/, () =>
        ok({ items: [scheduleV({ version: 1, lifecycleState: 'published' })] })],
      ...routes(),
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(family('plans')).getByRole('button', { name: 'پیش‌نویس تازه برای starter' }));
    const editor = await screen.findByTestId('plan-editor');

    // `V33-DEC-020`: a default here is a price the administrator did not pick.
    const picker = within(editor).getByLabelText('نسخهٔ جدول قیمت');
    expect(within(picker).getAllByRole('option')).toHaveLength(2);
    expect(picker).toHaveValue('');
  });

  it('still edits an existing draft, keeping its schedule version id unchanged and visible', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const row = await waitForRow('plans', 'starter', 2);
    await user.click(within(row).getByRole('button', { name: 'ویرایش پیش‌نویس ۲' }));
    const editor = await screen.findByTestId('plan-editor');
    expect(editor).toHaveTextContent(SCHEDULE_ID);
    expect(within(editor).queryByDisplayValue(SCHEDULE_ID)).toBeNull(); // shown, not editable

    await user.clear(within(editor).getByLabelText('اعتبار رزرو همراه طرح'));
    await user.type(within(editor).getByLabelText('اعتبار رزرو همراه طرح'), '25');
    await user.type(within(editor).getByLabelText('دلیل'), 'افزایش اعتبار');
    await user.click(within(editor).getByRole('button', { name: 'ذخیرهٔ پیش‌نویس' }));

    await waitFor(() => expect(api.sent('PUT', `${ADMIN}/plans/starter/versions/2`)).toHaveLength(1));
    expect(api.sent('PUT', `${ADMIN}/plans/starter/versions/2`)[0].body).toEqual({
      displayName: 'پایه',
      billingTermDays: 30,
      includedBookingCredits: 25,
      staffSeats: 2,
      includedLocations: 1,
      capabilityKeys: ['calendar'],
      priceScheduleVersionId: SCHEDULE_ID,
      bookingCreditScheduleKey: null,
      autoAssignable: false,
      activationStartsAt: FAR_PAST,
      activationEndsAt: null,
      reason: 'افزایش اعتبار',
    });
  });

  it('offers only booking-credit schedules for extra credits', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const row = await waitForRow('plans', 'starter', 2);
    await waitFor(() => expect(family('price-schedules')?.querySelector('[data-key="credit-pack"]')).toBeTruthy());
    await user.click(within(row).getByRole('button', { name: 'ویرایش پیش‌نویس ۲' }));
    const editor = await screen.findByTestId('plan-editor');
    const options = within(within(editor).getByLabelText('جدول قیمتِ اعتبار اضافه (اختیاری)')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['بدون فروش اعتبار اضافه', 'credit-pack']);
  });

  it('shows auto-assignment on each version', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const published = await waitForRow('plans', 'starter', 1);
    expect(published.querySelector('[data-auto-assignable="true"]')).toHaveTextContent('واگذاری خودکار: بله');
  });
});

describe('price schedules', () => {
  it('asks for the purpose with no default before a schedule key can be made', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(family('price-schedules')).getByRole('button', { name: 'شناسهٔ تازه' }));
    const form = screen.getByTestId('create-key-form');
    for (const radio of within(form).getAllByRole('radio')) expect(radio).not.toBeChecked();
    await user.type(within(form).getByLabelText('شناسه'), 'pack-2');
    await user.type(within(form).getByLabelText('دلیل'), 'بستهٔ تازه');
    expect(within(form).getByRole('button', { name: 'ساختن' })).toBeDisabled();
    await user.click(within(form).getByRole('radio', { name: 'قیمت اعتبار رزرو' }));
    await user.click(within(form).getByRole('button', { name: 'ساختن' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/price-schedules`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/price-schedules`)[0].body).toEqual({ scheduleKey: 'pack-2', purpose: 'booking_credit', reason: 'بستهٔ تازه' });
  });

  it('opens a new draft with no tiers and nothing pre-filled', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(family('price-schedules')).getByRole('button', { name: 'پیش‌نویس تازه برای seller-price' }));
    const editor = await screen.findByTestId('price-schedule-editor');
    expect(within(screen.getByTestId('tier-editor')).getByText('هنوز ردیفی ندارد.')).toBeInTheDocument();
    for (const input of within(editor).getAllByRole('spinbutton')) expect(input).toHaveValue(null);
    expect(within(editor).getByLabelText('نام نمایشی')).toHaveValue('');
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
  });

  it('names a tier gap in the server’s own words before sending, and sends nothing', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(family('price-schedules')).getByRole('button', { name: 'پیش‌نویس تازه برای seller-price' }));
    const editor = await screen.findByTestId('price-schedule-editor');
    // Everything else valid, so the gap is the ONLY thing between this and a request.
    await user.type(within(editor).getByLabelText('نام نمایشی'), 'بسته');
    await user.type(within(editor).getByLabelText('شروع فعال‌سازی'), '2026-10-01T09:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'دلیل کافی');
    await user.type(within(editor).getByLabelText('کمترین تعداد خرید'), '1');
    await user.type(within(editor).getByLabelText('بیشترین تعداد خرید'), '100');
    const tiers = screen.getByTestId('tier-editor');
    await user.click(within(tiers).getByRole('button', { name: 'افزودن ردیف' }));
    await user.click(within(tiers).getByRole('button', { name: 'افزودن ردیف' }));
    const [first, second] = within(tiers).getAllByRole('listitem');
    await user.type(within(first).getByLabelText('از تعداد'), '1');
    await user.type(within(first).getByLabelText('تا تعداد (اختیاری)'), '10');
    await user.type(within(first).getByLabelText('قیمت واحد (تومان)'), '5000');
    await user.type(within(second).getByLabelText('از تعداد'), '20');
    await user.type(within(second).getByLabelText('قیمت واحد (تومان)'), '4000');

    const problems = await screen.findByTestId('tier-problems');
    expect(problems).toHaveAttribute('role', 'alert');
    expect(problems.textContent).toMatch(/gap|contiguous/i);
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
    expect(api.writes()).toEqual([]);
  });

  it('sends a valid schedule exactly: integer tiers, an open top tier as null, presets ascending, the start typed', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(family('price-schedules')).getByRole('button', { name: 'پیش‌نویس تازه برای seller-price' }));
    const editor = await screen.findByTestId('price-schedule-editor');
    await user.type(within(editor).getByLabelText('نام نمایشی'), 'بستهٔ پاییز');
    await user.type(within(editor).getByLabelText('شروع فعال‌سازی'), '2026-10-01T09:00');
    await user.type(within(editor).getByLabelText('کمترین تعداد خرید'), '1');
    await user.type(within(editor).getByLabelText('بیشترین تعداد خرید'), '100');
    const presets = within(editor).getByRole('group', { name: 'تعدادهای پیشنهادی در رابط خرید (فقط نمایشی)' });
    for (const value of ['50', '10']) {
      await user.type(within(presets).getByRole('spinbutton'), value);
      await user.click(within(presets).getByRole('button', { name: 'افزودن' }));
    }
    const tiers = screen.getByTestId('tier-editor');
    await user.click(within(tiers).getByRole('button', { name: 'افزودن ردیف' }));
    const [tier] = within(tiers).getAllByRole('listitem');
    expect(within(tier).getByLabelText('قیمت واحد (تومان)')).toHaveAttribute('step', '1');
    await user.type(within(tier).getByLabelText('از تعداد'), '1');
    await user.type(within(tier).getByLabelText('قیمت واحد (تومان)'), '120000');
    await user.type(within(editor).getByLabelText('دلیل'), 'قیمت پاییز');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));

    await waitFor(() => expect(api.sent('POST', `${ADMIN}/price-schedules/seller-price/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/price-schedules/seller-price/versions`)[0].body).toEqual({
      displayName: 'بستهٔ پاییز',
      activationStartsAt: new Date('2026-10-01T09:00').toISOString(),
      activationEndsAt: null,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: 100,
      uiPresetQuantities: [10, 50],
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 120000 }],
      reason: 'قیمت پاییز',
    });
  });

  it('reads a draft’s tiers before editing it, because the list does not carry them', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const row = await waitForRow('price-schedules', 'seller-price', 2);
    await user.click(within(row).getByRole('button', { name: 'ویرایش پیش‌نویس ۲' }));
    const tiers = await screen.findByTestId('tier-editor');
    expect(api.sent('GET', `${ADMIN}/price-schedules/seller-price/versions/2`)).toHaveLength(1);
    expect(within(tiers).getAllByRole('listitem')).toHaveLength(1);
    expect(within(tiers).getByLabelText('قیمت واحد (تومان)')).toHaveValue(0);
  });

  it('shows a version’s tiers on demand', async () => {
    installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const row = await waitForRow('price-schedules', 'seller-price', 1);
    await user.click(within(row).getByRole('button', { name: 'نمایش ردیف‌های نسخهٔ ۱' }));
    expect(await within(row).findByText(/۱\+: ۰ تومان/)).toBeInTheDocument();
  });
});
