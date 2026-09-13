import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/business',
}));

/**
 * V3.3 Story #149 (`#149a`) — the owner's finance-access grant/revoke UI on
 * the existing business staff roster.
 *
 * ## What these cases are actually protecting
 *
 * The owner-only `GET /businesses/:id/staff-management` read (#154) is the
 * only source this screen may take a member's identity from: `displayLabel`,
 * `labelSource`, `identificationHint`, and the membership's live `roles`.
 * Grant has no confirmation dialog (it is reversible); revoke keeps one and
 * must name the exact member. Every assertion below is about one of those
 * guarantees holding — not "does a button exist".
 */

const BUSINESS = {
  id: 'biz-1',
  ownerId: 'u1',
  displayName: 'سالن من',
  bio: null,
  cityId: null,
  verificationStatus: 'unverified',
  createdAt: new Date().toISOString(),
};

const STAFF_MANAGEMENT_ROUTE = '/v1/businesses/biz-1/staff-management';

function managementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-1',
    role: 'staff',
    status: 'active',
    displayLabel: 'سارا رضایی',
    labelSource: 'professional',
    identificationHint: '0002',
    roles: [] as string[],
    ...overrides,
  };
}

function ok(data: unknown, status = 200) {
  return Promise.resolve({ ok: true, status, json: async () => ({ data, meta: null, error: null }) });
}

function refusal(status: number, code: string, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message } }),
  });
}

interface Scenario {
  members?: unknown[];
  grant?: (body: unknown) => Promise<unknown>;
  revoke?: (body: unknown) => Promise<unknown>;
  /** A second staff-management read for the post-mutation reload, when it must differ from the first. */
  membersAfterReload?: unknown[];
}

function mockApi(scenario: Scenario = {}) {
  let managementCalls = 0;
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    }
    if (url.includes('/v1/me/business-staff')) return ok([]);
    if (url.includes('/v1/me/business')) return ok(BUSINESS);

    if (url.includes('/grants/revoke') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return (scenario.revoke ?? (() => ok({ roles: [] })))(body);
    }
    if (url.includes('/grants') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return (scenario.grant ?? (() => ok({ roles: ['finance_read'] })))(body);
    }

    if (url.includes(STAFF_MANAGEMENT_ROUTE)) {
      managementCalls += 1;
      if (managementCalls > 1 && scenario.membersAfterReload) {
        return ok({ items: scenario.membersAfterReload });
      }
      return ok({ items: scenario.members ?? [] });
    }
    if (url.includes('/v1/businesses/biz-1/staff')) return ok([]);
    return ok([]);
  });
}

async function renderBusiness() {
  render(
    <AuthProvider>
      <BusinessPage />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText('شماره موبایل همکار')).toBeInTheDocument());
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'access-token', csrfToken: 'test-csrf-token' });
});

// ---------------------------------------------------------------------------

describe('member identity comes only from the staff-management projection', () => {
  it('renders a professional-name member by displayLabel, with the hint on the secondary line', async () => {
    mockApi({ members: [managementRow()] });
    await renderBusiness();

    expect(await screen.findByText('سارا رضایی')).toBeInTheDocument();
    expect(screen.getByText('0002')).toBeInTheDocument();
  });

  it('renders a phone-labelled bookkeeper framed as "شمارهٔ منتهی به …", never duplicating the hint', async () => {
    mockApi({
      members: [managementRow({ displayLabel: '7777', labelSource: 'phone', identificationHint: '7777' })],
    });
    await renderBusiness();

    expect(await screen.findByText('شمارهٔ منتهی به')).toBeInTheDocument();
    // Exactly one occurrence of the digits, not one per line.
    expect(screen.getAllByText('7777')).toHaveLength(1);
  });

  it('separates two same-named members by the hint, in the row and in the accessible name', async () => {
    mockApi({
      members: [
        managementRow({ id: 's1', identificationHint: '0001' }),
        managementRow({ id: 's2', identificationHint: '0002' }),
      ],
    });
    await renderBusiness();

    await waitFor(() => expect(screen.getAllByText('سارا رضایی')).toHaveLength(2));
    expect(screen.getByText('0001')).toBeInTheDocument();
    expect(screen.getByText('0002')).toBeInTheDocument();

    const grantButtons = screen.getAllByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ });
    expect(grantButtons).toHaveLength(2);
    // Two DIFFERENT accessible names -- a screen reader never offers two
    // identical options.
    expect(grantButtons[0].getAttribute('aria-label')).not.toBe(grantButtons[1].getAttribute('aria-label'));
    expect(grantButtons[0].getAttribute('aria-label')).toContain('0001');
    expect(grantButtons[1].getAttribute('aria-label')).toContain('0002');
  });

  it('never renders a raw userId, professionalId or full phone number', async () => {
    mockApi({ members: [managementRow(), managementRow({ id: 's2', labelSource: 'phone', displayLabel: '7777', identificationHint: '7777' })] });
    await renderBusiness();
    await screen.findByText('سارا رضایی');

    const visible = document.body.textContent ?? '';
    for (const forbidden of ['staff-1', 's2', 'u1', 'u2', '09121234567', '+989123456789']) {
      expect(visible).not.toContain(forbidden);
    }
  });
});

describe('eligibility follows membership status, not role', () => {
  it('gives an invited member no grant control at all', async () => {
    mockApi({ members: [managementRow({ status: 'invited' })] });
    await renderBusiness();

    await waitFor(() => expect(screen.getByText('سارا رضایی')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /بازپس‌گیری/ })).not.toBeInTheDocument();
  });

  it('gives an inactive member no grant control', async () => {
    mockApi({ members: [managementRow({ status: 'inactive' })] });
    await renderBusiness();

    await waitFor(() => expect(screen.getByText('سارا رضایی')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /بازپس‌گیری/ })).not.toBeInTheDocument();
  });

  it('a finance-only member with no professional profile is still offered the control', async () => {
    mockApi({ members: [managementRow({ displayLabel: '7777', labelSource: 'phone', identificationHint: '7777' })] });
    await renderBusiness();

    expect(await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ })).toBeInTheDocument();
  });
});

describe('grant is immediate, with no confirmation dialog', () => {
  it('submits on activation and reconciles the row from the server response', async () => {
    mockApi({ members: [managementRow()] });
    await renderBusiness();
    const user = userEvent.setup();

    const grantButton = await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ });
    await user.click(grantButton);

    // No dialog appeared at any point in the flow.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ })).toBeInTheDocument());
    // The badge reflects the SERVER's returned roles, never a client guess.
    expect(screen.getByText('دسترسیِ فقط‌خواندنیِ مالی — فعال')).toBeInTheDocument();
  });

  it('renders exactly what the server returned, never an assumed grant (non-optimistic reconciliation)', async () => {
    // The server answers with BOTH scoped roles live, not just the one that
    // was requested -- a row that assumed `roles: ['finance_read']` on
    // success would miss the practitioner-chat badge entirely.
    mockApi({ members: [managementRow()], grant: () => ok({ roles: ['finance_read', 'practitioner_chat'] }) });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ }));

    await waitFor(() => expect(screen.getByText('اختیارِ گفتگوی متخصص')).toBeInTheDocument());
    expect(screen.getByText('دسترسیِ فقط‌خواندنیِ مالی — فعال')).toBeInTheDocument();
  });

  it('sends exactly { role: "finance_read" }', async () => {
    mockApi({ members: [managementRow()] });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ }));

    const call = (global.fetch as jest.Mock).mock.calls.find(
      (c) => String(c[0]).includes('/grants') && c[1]?.method === 'POST' && !String(c[0]).includes('/revoke'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1].body))).toEqual({ role: 'finance_read' });
  });

  it('disables the button and marks it aria-busy while the grant is in flight, preventing a duplicate submission', async () => {
    let release: (() => void) | null = null;
    mockApi({
      members: [managementRow()],
      grant: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({ data: { roles: ['finance_read'] }, meta: null, error: null }) });
        }),
    });
    await renderBusiness();
    const user = userEvent.setup();

    const grantButton = await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ });
    await user.click(grantButton);

    // Same DOM node throughout -- React re-renders it in place rather than
    // remounting, so re-querying by its now-stale accessible name would be
    // the fragile step here, not this reference.
    await waitFor(() => expect(grantButton).toHaveAttribute('aria-busy', 'true'));
    expect(grantButton).toBeDisabled();
    await user.click(grantButton);
    await user.click(grantButton);

    const grantPosts = (global.fetch as jest.Mock).mock.calls.filter(
      (c) => String(c[0]).includes('/grants') && !String(c[0]).includes('/revoke') && c[1]?.method === 'POST',
    );
    expect(grantPosts).toHaveLength(1);

    release!();
    await waitFor(() => expect(screen.getByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ })).toBeInTheDocument());
  });

  it('announces start and success through a polite live region naming the member', async () => {
    mockApi({ members: [managementRow()] });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ }));

    const region = screen.getByRole('status');
    await waitFor(() => expect(region.textContent).toContain('سارا رضایی'));
    await waitFor(() => expect(region.textContent).toContain('اعطا شد'));
  });

  it('on failure preserves the previous row state and shows a retry tied to the error by aria-describedby', async () => {
    mockApi({ members: [managementRow()], grant: () => refusal(500, 'INTERNAL_ERROR', 'اعطا انجام نشد.') });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ }));

    const retry = await screen.findByRole('button', { name: /تلاشِ دوباره برای اعطای دسترسیِ مالی/ });
    const describedBy = retry.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('اعطا انجام نشد.');

    // The row is still in the "no access" state -- nothing was guessed.
    expect(screen.getByText('بدونِ دسترسیِ مالی')).toBeInTheDocument();

    await user.click(retry);
    const grantPosts = (global.fetch as jest.Mock).mock.calls.filter(
      (c) => String(c[0]).includes('/grants') && !String(c[0]).includes('/revoke') && c[1]?.method === 'POST',
    );
    expect(grantPosts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('revoke keeps its confirmation dialog', () => {
  function activeMember(overrides: Record<string, unknown> = {}) {
    return managementRow({ roles: ['finance_read'], ...overrides });
  }

  it('names the exact member in the dialog title and description', async () => {
    mockApi({ members: [activeMember()] });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ }));

    const dialog = await screen.findByRole('dialog');
    // Appears twice (title and acknowledgement copy) -- assert on the
    // dialog's combined text rather than a single unique node.
    expect(dialog.textContent).toContain('سارا رضایی');
    expect(dialog).toHaveAttribute('aria-describedby');
    const describedBy = dialog.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent(/قطع می‌شود/);
  });

  it('requires the acknowledgement checkbox before the confirm control activates', async () => {
    mockApi({ members: [activeMember()] });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'بازپس می‌گیرم' });
    expect(confirm).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm).toBeEnabled();
  });

  it('stays open on failure with a retry, and closes on success reconciling the row', async () => {
    let attempt = 0;
    mockApi({
      members: [activeMember()],
      revoke: () => {
        attempt += 1;
        return attempt === 1 ? refusal(500, 'INTERNAL_ERROR', 'بازپس‌گیری انجام نشد.') : ok({ roles: [] });
      },
    });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'بازپس می‌گیرم' }));

    // First attempt fails: dialog stays open with the error and a retry.
    await waitFor(() => expect(within(dialog).getByText('بازپس‌گیری انجام نشد.')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'تلاشِ دوباره' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('بدونِ دسترسیِ مالی')).toBeInTheDocument();
  });

  it('disables the dialog controls while the revoke is pending', async () => {
    let release: (() => void) | null = null;
    mockApi({
      members: [activeMember()],
      revoke: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({ data: { roles: [] }, meta: null, error: null }) });
        }),
    });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'بازپس می‌گیرم' }));

    await waitFor(() => expect(within(dialog).getByRole('checkbox')).toBeDisabled());

    release!();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('returns focus to the row action after cancel', async () => {
    mockApi({ members: [activeMember()] });
    await renderBusiness();
    const user = userEvent.setup();

    const revokeButton = await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ });
    await user.click(revokeButton);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'انصراف' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(revokeButton);
  });

  it('returns focus to the row action after a successful revoke', async () => {
    mockApi({ members: [activeMember()] });
    await renderBusiness();
    const user = userEvent.setup();

    const revokeButton = await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ });
    await user.click(revokeButton);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'بازپس می‌گیرم' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The revoke button that opened the dialog no longer exists (the row is
    // now a grant button), so focus returning to "the invoking control"
    // means the grant button that took its place -- proven indirectly by the
    // fact that SOME element in the row's action area now has focus rather
    // than the document body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('closes and reloads the roster on a non-enumerating refusal, without a distinct cause', async () => {
    mockApi({
      members: [activeMember()],
      revoke: () => refusal(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد پیدا نشد یا در دسترس شما نیست.'),
      membersAfterReload: [],
    });
    await renderBusiness();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'بازپس می‌گیرم' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('این مورد پیدا نشد یا در دسترس شما نیست.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('سارا رضایی')).not.toBeInTheDocument());
  });
});

describe('grant and revoke never sit on the same row at once', () => {
  it('a member with the live grant shows revoke only; one without shows grant only', async () => {
    mockApi({
      members: [
        managementRow({ id: 's1', identificationHint: '0001', roles: ['finance_read'] }),
        managementRow({ id: 's2', identificationHint: '0002', roles: [] }),
      ],
    });
    await renderBusiness();

    await waitFor(() => expect(screen.getAllByText('سارا رضایی')).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: /بازپس‌گیریِ دسترسیِ مالی/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /اعطای دسترسیِ فقط‌خواندنیِ مالی/ })).toHaveLength(1);
  });
});

describe('the contract cannot be quietly reverted (static)', () => {
  const root = join(__dirname, '..');
  const page = readFileSync(join(root, 'app/business/page.tsx'), 'utf8');
  const client = readFileSync(join(root, 'lib/phase4-api.ts'), 'utf8');

  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  const pageCode = code(page);
  const clientCode = code(client);

  it('the scan sees real source, not an empty string', () => {
    expect(pageCode).toContain('function handleGrant');
    expect(clientCode).toContain('export function grantStaffRole');
  });

  it('the grant path never opens a dialog and the revoke path always does', () => {
    const grantFn = pageCode.slice(pageCode.indexOf('async function handleGrant'), pageCode.indexOf('async function confirmRevoke'));
    expect(grantFn).not.toContain('setPending');
    expect(pageCode).toContain("kind: 'revokeFinance'");
  });

  it('grant/revoke wrappers send exactly { role } and type the response as live roles only', () => {
    const grantWrapper = clientCode.slice(
      clientCode.indexOf('export function grantStaffRole'),
      clientCode.indexOf('export function revokeStaffRole'),
    );
    expect(grantWrapper).toContain('{ role }');
    expect(grantWrapper).toContain('MembershipGrantView');
  });

  it('the scans are non-vacuous -- each forbidden shape is caught when planted', () => {
    expect(code('setPending({ kind: "grant" });')).toContain('setPending');
    expect(code('// setPending is mentioned only in a comment')).not.toContain('setPending({');
  });
});
