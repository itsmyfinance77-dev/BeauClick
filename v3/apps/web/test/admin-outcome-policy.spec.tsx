/**
 * @jest-environment ./test/ambient-zone-environment.js
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminOutcomePolicyPage from '@/app/admin/commercial/outcome-policy/page';
import { AuthProvider } from '@/lib/auth-context';
import { ACTIVATION_END_LABEL } from '@/lib/commercial-lifecycle';
import { tokenStorage } from '@/lib/token-storage';
import { withAmbientZone } from './ambient-zone';
import { ADMIN, FAR_PAST, fail, installFakeApi, ok, type Route } from './commercial-fake-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/commercial/outcome-policy',
}));

/**
 * `/admin/commercial/outcome-policy`, against `47_ADMIN_OUTCOME_POLICY.md`:
 * nothing seeded and nothing defaulted, a one-way lifecycle whose published
 * rows carry no edit control, a reason on every mutation, a legal cap only
 * against qualifying evidence, exactly one active customer copy, and refusals
 * that keep what the administrator typed.
 */

const CAP = ['bc_manage_commercial_plans'];

const base = {
  policyKey: 'standard-outcome',
  cutoffHoursAllowed: [24, 48],
  lateRetentionOptions: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 5000 }],
  noShowGraceMinutesAllowed: [15],
  noShowRetentionOptions: [{ kind: 'full_collected' }],
  rescheduleFreeCountBeforeCutoff: 1,
  disputeWindowHours: 72,
  bodilyHarmWindowHours: null,
  appealWindowHours: 168,
  caseFileRetentionDays: null,
  legalCap: null,
  legalEvidenceKey: null,
  contractVersion: 1,
  activationEndsAt: null,
  retiredAt: null,
};
const VERSIONS = [
  { ...base, version: 1, lifecycleState: 'retired', activationStartsAt: FAR_PAST, activationEndsAt: '2021-01-01T00:00:00.000Z', publishedAt: FAR_PAST, retiredAt: '2021-01-01T00:00:00.000Z' },
  { ...base, version: 2, lifecycleState: 'published', activationStartsAt: FAR_PAST, publishedAt: FAR_PAST },
  { ...base, version: 3, lifecycleState: 'draft', activationStartsAt: null, publishedAt: null },
];

const EVIDENCE = [
  { evidenceKey: 'cap-ok', subject: 'retention_cap', status: 'recorded', referenceKind: 'counsel_letter_reference', recordedAt: FAR_PAST, retiredAt: null },
  { evidenceKey: 'cap-old', subject: 'retention_cap', status: 'retired', referenceKind: 'internal_ticket', recordedAt: FAR_PAST, retiredAt: FAR_PAST },
  { evidenceKey: 'copy-ok', subject: 'policy_copy', status: 'recorded', referenceKind: 'document_reference', recordedAt: FAR_PAST, retiredAt: null },
];

const COPY_ACTIVE = { copyKey: 'checkout-copy', version: 2, lifecycleState: 'published', locale: 'fa-IR', bodySha256: 'abcdef0123456789', contractVersion: 1, activationStartsAt: FAR_PAST, activationEndsAt: null, publishedAt: FAR_PAST, retiredAt: null };
const COPY_OLD = { ...COPY_ACTIVE, version: 1, activationEndsAt: '2021-01-01T00:00:00.000Z' };

function routes({
  policies = [{ policyKey: 'standard-outcome', displayName: 'استاندارد', createdAt: FAR_PAST }],
  versions = VERSIONS,
  evidence = EVIDENCE,
  copies = [{ copyKey: 'checkout-copy', displayName: 'متن پرداخت', createdAt: FAR_PAST }],
  copyVersions = [COPY_OLD, COPY_ACTIVE],
  overrides = [],
}: {
  policies?: unknown[];
  versions?: unknown[];
  evidence?: unknown[];
  copies?: unknown[];
  copyVersions?: unknown[];
  overrides?: Route[];
} = {}): Route[] {
  return [
    ...overrides,
    ['GET', /^\/v1\/admin\/commercial\/outcome-policies$/, () => ok({ items: policies })],
    ['GET', /^\/v1\/admin\/commercial\/outcome-policies\/[^/]+\/versions$/, () => ok({ items: versions })],
    ['POST', /^\/v1\/admin\/commercial\/outcome-policies\/[^/]+\/versions$/, () => ok({ ...base, version: 4, lifecycleState: 'draft', activationStartsAt: null, publishedAt: null })],
    ['POST', /\/publish$/, () => ok({})],
    ['POST', /\/retire$/, () => ok({})],
    ['DELETE', /\/versions\/\d+$/, () => ok({ discarded: true })],
    ['GET', /^\/v1\/admin\/commercial\/legal-evidence$/, () => ok({ items: evidence })],
    ['GET', /^\/v1\/admin\/commercial\/legal-evidence\/([^/]+)$/, (m) => ok({ ...EVIDENCE[0], evidenceKey: m[1], reference: 'LTR-2026-114', summary: 'نامهٔ مشاور حقوقی دربارهٔ سقف' })],
    ['GET', /^\/v1\/admin\/commercial\/customer-policy-copies$/, () => ok({ items: copies })],
    ['GET', /^\/v1\/admin\/commercial\/customer-policy-copies\/[^/]+\/versions$/, () => ok({ items: copyVersions })],
    ['GET', /^\/v1\/admin\/commercial\/customer-policy-copies\/([^/]+)\/versions\/(\d+)$/, (m) => ok({ ...COPY_ACTIVE, version: Number(m[2]), body: `متن نسخهٔ ${m[2]}` })],
  ];
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminOutcomePolicyPage />
    </AuthProvider>,
  );
}

const family = (id: string) => document.querySelector(`[data-family="${id}"]`) as HTMLElement;
const versionRow = (id: string, version: number) =>
  family(id).querySelector(`[data-version="${version}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a platform operator without `bc_manage_commercial_plans`, and reads nothing', async () => {
    const api = installFakeApi(['bc_manage_platform', 'bc_moderate_verification'], routes());
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });
});

describe('a fresh platform', () => {
  it('shows every family empty as a normal state — never an error', async () => {
    installFakeApi(CAP, routes({ policies: [], evidence: [], copies: [] }));
    renderPage();
    expect(await screen.findByText(/هنوز هیچ سیاست پیامدی تعریف نشده است/)).toBeInTheDocument();
    expect(await screen.findByText('هنوز هیچ متن سیاستی برای مشتری تعریف نشده است.')).toBeInTheDocument();
    expect(await screen.findByText(/هنوز هیچ مدرکی ثبت نشده است/)).toBeInTheDocument();
    expect(screen.getByText('هیچ متنی برای مشتری مؤثر نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
  });

  it('does not call a failed read an empty list, and offers a retry', async () => {
    installFakeApi(CAP, routes({ overrides: [['GET', /^\/v1\/admin\/commercial\/outcome-policies$/, () => fail(500, 'INTERNAL', 'خطای سرور')]] }));
    renderPage();
    await waitFor(() => expect(family('outcome-policies')).not.toBeNull());
    expect(await within(family('outcome-policies')).findByText('خطای سرور')).toBeInTheDocument();
    expect(within(family('outcome-policies')).queryByText(/هنوز هیچ سیاست پیامدی/)).toBeNull();
    expect(within(family('outcome-policies')).getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});

describe('the lifecycle', () => {
  it('renders the stored and the derived states as two groups, and no gate group on this page', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const legend = await screen.findByTestId('lifecycle-legend');
    expect(legend.querySelector('[data-legend-group="stored"]')).not.toBeNull();
    expect(legend.querySelector('[data-legend-group="derived"]')).not.toBeNull();
    expect(legend.querySelector('[data-legend-group="gates"]')).toBeNull();
  });

  it('gives a draft edit, publish and discard; a published version only retire — no edit, not even disabled; a retired one nothing', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    const names = (v: number) => within(versionRow('outcome-policies', v)).queryAllByRole('button').map((b) => b.textContent);
    expect(names(3)).toEqual(['ویرایش', 'انتشار', 'دور انداختن']);
    expect(names(2)).toEqual(['بازنشستگی']);
    expect(names(1)).toEqual([]);
  });

  it('marks a published version in its window as active — derived, alongside its stored state', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 2)).not.toBeNull());
    const row = versionRow('outcome-policies', 2);
    expect(row.querySelector('[data-lifecycle="published"]')).not.toBeNull();
    expect(row.querySelector('[data-derived="active"]')).not.toBeNull();
    expect(versionRow('outcome-policies', 1).querySelector('[data-derived]')).toBeNull();
  });
});

describe('the editor', () => {
  async function openNewDraft() {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    await user.click(within(family('outcome-policies')).getByRole('button', { name: 'پیش‌نویس تازه برای standard-outcome' }));
    return { user, editor: await screen.findByTestId('outcome-policy-editor') };
  }

  it('opens with nothing filled in: every set empty, every number blank, no cap, and nothing to submit', async () => {
    installFakeApi(CAP, routes());
    const { editor } = await openNewDraft();
    expect(within(editor).getAllByText('هنوز عضوی ندارد.')).toHaveLength(2);
    expect(within(editor).getAllByText('هنوز گزینه‌ای ندارد.')).toHaveLength(2);
    for (const input of within(editor).getAllByRole('spinbutton')) expect(input).toHaveValue(null);
    expect(within(editor).getByRole('checkbox', { name: 'این نسخه سقف قانونی دارد' })).not.toBeChecked();
    expect(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' })).toBeDisabled();
  });

  it('offers a legal cap only when a RECORDED retention-cap record exists', async () => {
    installFakeApi(CAP, routes({ evidence: EVIDENCE.slice(1) }));
    const { editor } = await openNewDraft();
    expect(within(editor).queryByRole('checkbox')).toBeNull();
    expect(within(screen.getByTestId('legal-cap')).getByRole('note')).toHaveTextContent('هنوز چنین مدرکی در فهرست مدارک نیست');
  });

  it('lists only qualifying evidence for the cap', async () => {
    installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    await user.click(within(editor).getByRole('checkbox', { name: 'این نسخه سقف قانونی دارد' }));
    const options = within(within(editor).getByLabelText('مدرک حقوقی')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['انتخاب کنید', 'cap-ok']);
  });

  it('sends exactly the terms typed, sets ascending, empty optionals as null, and no activation start', async () => {
    const api = installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();

    const setInput = (legend: string) => within(within(editor).getByRole('group', { name: legend })).getByRole('spinbutton');
    const setAdd = (legend: string) => within(within(editor).getByRole('group', { name: legend })).getByRole('button', { name: 'افزودن' });
    for (const value of ['48', '24']) {
      await user.type(setInput('ساعت‌های مجاز برای مهلت لغو رایگان'), value);
      await user.click(setAdd('ساعت‌های مجاز برای مهلت لغو رایگان'));
    }
    await user.type(setInput('دقیقه‌های مجاز برای مهلت اعلام عدم‌حضور'), '15');
    await user.click(setAdd('دقیقه‌های مجاز برای مهلت اعلام عدم‌حضور'));

    const late = within(editor).getByRole('group', { name: 'گزینه‌های نگه‌داشت در لغو دیرهنگام' });
    await user.selectOptions(within(late).getByLabelText('شکل گزینهٔ تازه'), 'percentage_of_collected');
    await user.type(within(late).getByRole('spinbutton'), '2500');
    await user.click(within(late).getByRole('button', { name: 'افزودن گزینه' }));
    const noShow = within(editor).getByRole('group', { name: 'گزینه‌های نگه‌داشت در عدم‌حضور' });
    await user.selectOptions(within(noShow).getByLabelText('شکل گزینهٔ تازه'), 'full_collected');
    await user.click(within(noShow).getByRole('button', { name: 'افزودن گزینه' }));

    await user.type(within(editor).getByLabelText('جابه‌جایی رایگان پیش از مهلت (بار)'), '0');
    await user.type(within(editor).getByLabelText('مهلت اعتراض (ساعت)'), '72');
    await user.type(within(editor).getByLabelText('مهلت درخواست بازبینی (ساعت)'), '168');
    await user.type(within(editor).getByLabelText('دلیل'), '  نسخهٔ آزمایشی  ');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));

    await waitFor(() => expect(api.sent('POST', `${ADMIN}/outcome-policies/standard-outcome/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/outcome-policies/standard-outcome/versions`)[0].body).toEqual({
      cutoffHoursAllowed: [24, 48],
      lateRetentionOptions: [{ kind: 'percentage_of_collected', basisPoints: 2500 }],
      noShowGraceMinutesAllowed: [15],
      noShowRetentionOptions: [{ kind: 'full_collected' }],
      rescheduleFreeCountBeforeCutoff: 0,
      disputeWindowHours: 72,
      bodilyHarmWindowHours: null,
      appealWindowHours: 168,
      caseFileRetentionDays: null,
      legalCap: null,
      legalEvidenceKey: null,
      activationEndsAt: null,
      reason: 'نسخهٔ آزمایشی',
    });
  });

  it('refuses a duplicate set member instead of sending one', async () => {
    installFakeApi(CAP, routes());
    const { user, editor } = await openNewDraft();
    const group = within(editor).getByRole('group', { name: 'ساعت‌های مجاز برای مهلت لغو رایگان' });
    await user.type(within(group).getByRole('spinbutton'), '24');
    await user.click(within(group).getByRole('button', { name: 'افزودن' }));
    await user.type(within(group).getByRole('spinbutton'), '24');
    expect(within(group).getByRole('button', { name: 'افزودن' })).toBeDisabled();
    expect(within(group).getByText('این مقدار از پیش در مجموعه هست.')).toBeInTheDocument();
  });

  it('keeps the draft on screen when the server refuses the terms, and lists its problems verbatim', async () => {
    installFakeApi(
      CAP,
      routes({
        overrides: [
          [
            'PUT',
            /\/versions\/3$/,
            () => fail(422, 'COMMERCIAL_TERMS_INVALID', 'شرایط واردشده معتبر نیست.', { problems: ['bodilyHarmWindowHours cannot be shorter than disputeWindowHours'] }),
          ],
        ],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    await user.click(within(versionRow('outcome-policies', 3)).getByRole('button', { name: 'ویرایش پیش‌نویس ۳' }));
    const editor = await screen.findByTestId('outcome-policy-editor');
    await user.type(within(editor).getByLabelText('دلیل'), 'اصلاح');
    await user.click(within(editor).getByRole('button', { name: 'ذخیرهٔ پیش‌نویس' }));

    const alert = await within(editor).findByRole('alert');
    expect(alert).toHaveTextContent('شرایط واردشده معتبر نیست.');
    expect(within(alert).getByText('bodilyHarmWindowHours cannot be shorter than disputeWindowHours')).toBeInTheDocument();
    expect(screen.getByTestId('outcome-policy-editor')).toBeInTheDocument();
    expect(within(editor).getByLabelText('دلیل')).toHaveValue('اصلاح');
  });
});

describe('publishing', () => {
  it('waits for a reason of three characters, says the server sets the instant, and sends only the reason', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    await user.click(within(versionRow('outcome-policies', 3)).getByRole('button', { name: 'انتشار نسخهٔ ۳' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleDescription(/لحظهٔ فعال‌سازی را سرور تعیین می‌کند/);
    const confirm = within(dialog).getByRole('button', { name: 'انتشار' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('دلیل'), 'ab');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('دلیل'), 'c');
    await user.click(confirm);

    await waitFor(() => expect(api.sent('POST', `${ADMIN}/outcome-policies/standard-outcome/versions/3/publish`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/outcome-policies/standard-outcome/versions/3/publish`)[0].body).toEqual({ reason: 'abc' });
  });

  it('keeps the dialog and the reason when publication would overlap an effective version', async () => {
    installFakeApi(CAP, routes({ overrides: [['POST', /\/publish$/, () => fail(409, 'COMMERCIAL_ACTIVATION_OVERLAP', 'بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد.')]] }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    await user.click(within(versionRow('outcome-policies', 3)).getByRole('button', { name: 'انتشار نسخهٔ ۳' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل'), 'انتشار تابستانی');
    await user.click(within(dialog).getByRole('button', { name: 'انتشار' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد.');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByLabelText('دلیل')).toHaveValue('انتشار تابستانی');
  });

  it('reloads the versions when the version stopped being a draft under it', async () => {
    const api = installFakeApi(
      CAP,
      routes({ overrides: [['POST', /\/publish$/, () => fail(409, 'COMMERCIAL_LIFECYCLE_CONFLICT', 'وضعیت این نسخه اجازه این تغییر را نمی‌دهد.', { detail: 'version 3 is published' })]] }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    const before = api.sent('GET', `${ADMIN}/outcome-policies/standard-outcome/versions`).length;
    await user.click(within(versionRow('outcome-policies', 3)).getByRole('button', { name: 'انتشار نسخهٔ ۳' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل'), 'انتشار');
    await user.click(within(dialog).getByRole('button', { name: 'انتشار' }));

    expect(await within(dialog).findByText('version 3 is published')).toBeInTheDocument();
    await waitFor(() => expect(api.sent('GET', `${ADMIN}/outcome-policies/standard-outcome/versions`).length).toBe(before + 1));
  });
});

describe('customer copy', () => {
  it('shows exactly one active copy, with its text read on its own', async () => {
    const api = installFakeApi(CAP, routes());
    renderPage();
    const card = await screen.findByTestId('active-copy');
    expect(await within(card).findByText('متن نسخهٔ 2')).toBeInTheDocument();
    expect(card.querySelectorAll('[data-copy]')).toHaveLength(1);
    expect(api.sent('GET', `${ADMIN}/customer-policy-copies/checkout-copy/versions/2`)).toHaveLength(1);
  });
});

describe('the evidence register', () => {
  it('lists vocabulary only, and reads a reference and summary on demand', async () => {
    const api = installFakeApi(CAP, routes());
    const user = userEvent.setup();
    renderPage();
    const register = await screen.findByTestId('evidence-register');
    await waitFor(() => expect(register.querySelector('[data-evidence="cap-ok"]')).not.toBeNull());
    const row = register.querySelector('[data-evidence="cap-ok"]') as HTMLElement;
    expect(register.textContent).not.toContain('LTR-2026-114');
    await user.click(within(row).getByRole('button', { name: /مشاهدهٔ ارجاع و خلاصهٔ cap-ok/ }));
    expect(await within(row).findByText('LTR-2026-114')).toBeInTheDocument();
    expect(api.sent('GET', `${ADMIN}/legal-evidence/cap-ok`)).toHaveLength(1);
  });

  it('offers retirement only on a recorded record', async () => {
    installFakeApi(CAP, routes());
    renderPage();
    const register = await screen.findByTestId('evidence-register');
    await waitFor(() => expect(register.querySelector('[data-evidence="cap-old"]')).not.toBeNull());
    expect(within(register.querySelector('[data-evidence="cap-ok"]') as HTMLElement).queryByRole('button', { name: /بازنشستگی/ })).not.toBeNull();
    expect(within(register.querySelector('[data-evidence="cap-old"]') as HTMLElement).queryByRole('button', { name: /بازنشستگی/ })).toBeNull();
  });
});

/*
 * #321. The operator's machine is on UTC; an end typed in either editor on
 * this page is still Tehran's wall clock, and a draft opens at the Tehran time
 * it means.
 */
describe('activation ends on this page are Tehran time, whatever zone the operator is in (#321)', () => {
  withAmbientZone('UTC');

  it('opens an outcome-policy draft at the Tehran time it was saved with, and saves an end typed as the Tehran instant', async () => {
    const api = installFakeApi(
      CAP,
      routes({
        versions: [VERSIONS[1], { ...VERSIONS[2], activationEndsAt: '2025-12-31T20:30:00.000Z' }],
        overrides: [['PUT', /^\/v1\/admin\/commercial\/outcome-policies\/[^/]+\/versions\/3$/, () => ok(VERSIONS[2])]],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('outcome-policies', 3)).not.toBeNull());
    await user.click(within(versionRow('outcome-policies', 3)).getByRole('button', { name: 'ویرایش پیش‌نویس ۳' }));
    const editor = await screen.findByTestId('outcome-policy-editor');
    const end = within(editor).getByLabelText(ACTIVATION_END_LABEL);
    expect(end).toHaveValue('2026-01-01T00:00');

    await user.clear(end);
    await user.type(end, '2026-03-21T02:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'پایان نوروز');
    await user.click(within(editor).getByRole('button', { name: 'ذخیرهٔ پیش‌نویس' }));
    await waitFor(() => expect(api.sent('PUT', `${ADMIN}/outcome-policies/standard-outcome/versions/3`)).toHaveLength(1));
    expect(api.sent('PUT', `${ADMIN}/outcome-policies/standard-outcome/versions/3`)[0].body).toMatchObject({ activationEndsAt: '2026-03-20T22:30:00.000Z' });
  });

  it('sends a customer copy’s end typed as the Tehran instant', async () => {
    const api = installFakeApi(
      CAP,
      routes({ overrides: [['POST', /^\/v1\/admin\/commercial\/customer-policy-copies\/[^/]+\/versions$/, () => ok({ ...COPY_ACTIVE, version: 3, lifecycleState: 'draft', body: 'متن' })]] }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(versionRow('policy-copies', 2)).not.toBeNull());
    await user.click(within(family('policy-copies')).getByRole('button', { name: 'پیش‌نویس تازه برای checkout-copy' }));
    const editor = await screen.findByTestId('policy-copy-editor');
    await user.type(within(editor).getByLabelText('متن سیاست'), 'متن تازه');
    await user.type(within(editor).getByLabelText(ACTIVATION_END_LABEL), '2026-01-01T09:00');
    await user.type(within(editor).getByLabelText('دلیل'), 'متن تازه');
    await user.click(within(editor).getByRole('button', { name: 'ثبت پیش‌نویس' }));
    await waitFor(() => expect(api.sent('POST', `${ADMIN}/customer-policy-copies/checkout-copy/versions`)).toHaveLength(1));
    expect(api.sent('POST', `${ADMIN}/customer-policy-copies/checkout-copy/versions`)[0].body).toMatchObject({ activationEndsAt: '2026-01-01T05:30:00.000Z' });
  });
});
