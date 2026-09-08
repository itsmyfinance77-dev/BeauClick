import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/business',
}));

/**
 * V3.3 Story #123 — the web staff-invitation screen on V3.3 Story #109's
 * (`#44c`) contract.
 *
 * ## What these cases are actually protecting
 *
 * `V33-DEC-033` R3/R4 replaced an invitation that took an identity UUID and
 * returned the membership row with one that takes a phone number and returns a
 * byte-identical `202 {}` for **every** well-formed outcome — known, unknown,
 * self, duplicate, affiliated-elsewhere, deleted. The backend removed an
 * enumeration oracle; the risk this file guards is that the **browser** rebuilds
 * it, which it can do in ways the server cannot see:
 *
 *   * branching the confirmation on anything in the response;
 *   * reading a membership id back out of an empty body;
 *   * refreshing the roster next to the confirmation, so a row appearing means
 *     "that phone belongs to a real account";
 *   * reintroducing a `userId` field, a lookup, or a contact picker.
 *
 * So the assertions below are about **indistinguishability**, not about which
 * message appears. Where an assertion could pass without the form ever
 * submitting, a non-vacuity control proves it exercised the real path.
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

const STAFF_ROUTE = '/v1/businesses/biz-1/staff';

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-1',
    businessId: 'biz-1',
    userId: 'u2',
    professionalId: null,
    role: 'staff',
    status: 'active',
    invitedBy: 'u1',
    respondedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function ok(data: unknown, status = 200) {
  return Promise.resolve({ ok: true, status, json: async () => ({ data, meta: null, error: null }) });
}

/** The server's own envelope for a refusal — the client never invents this copy. */
function refusal(status: number, code: string, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message } }),
  });
}

function calls(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    (c) => String(c[0]).includes(fragment) && (method === undefined || c[1]?.method === method),
  );
}

/** Every request this page has made, for the "no new endpoint" assertions. */
function allUrls(): string[] {
  return (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
}

interface Scenario {
  /** What the invite POST answers. Defaults to the real `202 {}`. */
  invite?: () => Promise<unknown>;
  staff?: unknown[];
}

function mockApi(scenario: Scenario = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'fresh', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    }
    // Checked BEFORE the roster route: both contain "staff".
    if (url.includes('/v1/me/business-staff')) return ok([]);
    if (url.includes('/v1/me/business')) return ok(BUSINESS);
    if (url.includes(STAFF_ROUTE) && init?.method === 'POST') {
      return (scenario.invite ?? (() => ok({}, 202)))();
    }
    if (url.includes(STAFF_ROUTE)) return ok(scenario.staff ?? []);
    return ok([]);
  });
}

async function renderBusiness() {
  render(
    <AuthProvider>
      <BusinessPage />
    </AuthProvider>,
  );
  // The invite form only exists once the owned business has loaded.
  await waitFor(() => expect(screen.getByLabelText('شماره موبایل همکار')).toBeInTheDocument());
}

async function invite(phone: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('شماره موبایل همکار'), phone);
  await user.click(screen.getByRole('button', { name: 'ارسال دعوت' }));
  return user;
}

const SUCCESS_COPY = 'درخواست دعوت دریافت شد و در حال بررسی است.';

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'access-token', csrfToken: 'test-csrf-token' });
});

// ---------------------------------------------------------------------------

describe('the invite form collects a phone, not an identity', () => {
  it('renders a phone field and no user-id field, with the role vocabulary unchanged', async () => {
    mockApi();
    await renderBusiness();

    const field = screen.getByLabelText('شماره موبایل همکار') as HTMLInputElement;
    expect(field).toHaveAttribute('type', 'tel');
    expect(field).toHaveAttribute('inputMode', 'numeric');
    expect(field).toHaveAttribute('autoComplete', 'tel');

    // The replaced contract's field is gone from the screen entirely.
    expect(screen.queryByLabelText('شناسه کاربری فرد مورد نظر')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/شناسه کاربری/)).not.toBeInTheDocument();

    // The membership vocabulary is untouched — scoped grants are a different
    // axis and no screen is authorized for them here.
    const roleGroup = screen.getByRole('group', { name: 'نقش' });
    const roleNames = Array.from(roleGroup.querySelectorAll('button')).map((b) => b.textContent);
    expect(roleNames).toEqual(['کارمند', 'مدیر']);
    expect(screen.queryByText(/practitioner_chat/i)).not.toBeInTheDocument();
  });

  it('sends EXACTLY { phone, role } to exactly the unchanged staff route', async () => {
    mockApi();
    await renderBusiness();
    await invite('09121234567');

    await waitFor(() => expect(calls(STAFF_ROUTE, 'POST')).toHaveLength(1));
    const [url, init] = calls(STAFF_ROUTE, 'POST')[0];
    expect(String(url).endsWith(STAFF_ROUTE)).toBe(true);

    const body = JSON.parse(String(init.body));
    // Exact key set: a legacy field re-added, or an `undefined` one serialised,
    // fails here rather than being tolerated by the server.
    expect(Object.keys(body).sort()).toEqual(['phone', 'role']);
    expect(body).toEqual({ phone: '09121234567', role: 'staff' });
  });

  it('normalises Persian digits with the platform helper rather than a second phone rule', async () => {
    mockApi();
    await renderBusiness();
    await invite('۰۹۱۲۱۲۳۴۵۶۷');

    await waitFor(() => expect(calls(STAFF_ROUTE, 'POST')).toHaveLength(1));
    const body = JSON.parse(String(calls(STAFF_ROUTE, 'POST')[0][1].body));
    expect(body.phone).toBe('09121234567');
  });
});

describe('a 202 is success, and every 202 looks the same', () => {
  it('treats the neutral response as success without reading a membership id', async () => {
    mockApi();
    await renderBusiness();
    await invite('09121234567');

    await waitFor(() => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument());

    // Nothing the contract deliberately withholds may appear anywhere on screen.
    const visible = document.body.textContent ?? '';
    for (const leaked of ['staff-1', 'u2', 'prof-', '09121234567', '۰۹۱۲۱۲۳۴۵۶۷']) {
      expect(visible).not.toContain(leaked);
    }
    // And the CONFIRMATION itself claims nothing the response cannot support:
    // no membership created, no SMS delivered, no invitee named. Scoped to the
    // alert because the surrounding roster copy legitimately says "عضو".
    const confirmation = screen.getByRole('alert').textContent ?? '';
    expect(confirmation).toBe(SUCCESS_COPY);
    expect(confirmation).not.toMatch(/عضو|پیامک|ارسال شد به|حساب|ثبت شد/);
  });

  it('produces a BYTE-IDENTICAL confirmation across indistinguishable accepted responses', async () => {
    /*
     * The server sends the same bytes for known, unknown, self, duplicate,
     * foreign and deleted. What varies here is only the shape an accepted
     * response could legitimately arrive in, because varying the *semantic
     * cause* would mean mocking a distinction into the UI contract that does not
     * exist. If any branch on the response body were added, these would differ.
     */
    const accepted = [() => ok({}, 202), () => ok(null, 202), () => ok({}, 200)];
    const rendered: string[] = [];

    for (const invitation of accepted) {
      global.fetch = jest.fn() as unknown as typeof fetch;
      mockApi({ invite: invitation });
      const view = render(
        <AuthProvider>
          <BusinessPage />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('شماره موبایل همکار')).toBeInTheDocument());
      await invite('09121234567');
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      rendered.push(screen.getByRole('alert').textContent ?? '');
      view.unmount();
    }

    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toBe(SUCCESS_COPY);

    // Non-vacuity: the loop really did submit three times, once per scenario.
    expect(rendered).toHaveLength(3);
  });

  it('does NOT refresh the roster on success — a row appearing would be the oracle again', async () => {
    mockApi();
    await renderBusiness();
    const rosterReadsBefore = calls(STAFF_ROUTE, undefined).filter((c) => c[1]?.method !== 'POST').length;

    await invite('09121234567');
    await waitFor(() => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument());

    const rosterReadsAfter = calls(STAFF_ROUTE, undefined).filter((c) => c[1]?.method !== 'POST').length;
    expect(rosterReadsAfter).toBe(rosterReadsBefore);
    // Non-vacuity: the page really does read the roster at least once on load,
    // so "no additional read" is an observation rather than an accident.
    expect(rosterReadsBefore).toBeGreaterThan(0);
  });
});

describe('refusals stay refusals', () => {
  it('shows a malformed phone as a correctable field error and KEEPS what was typed', async () => {
    mockApi({ invite: () => refusal(400, 'VALIDATION_ERROR', 'شماره موبایل معتبر نیست.') });
    await renderBusiness();
    await invite('123');

    await waitFor(() => expect(screen.getByText('شماره موبایل معتبر نیست.')).toBeInTheDocument());
    // Retained, so the number can be corrected rather than retyped.
    expect((screen.getByLabelText('شماره موبایل همکار') as HTMLInputElement).value).toBe('123');
    expect(screen.queryByText(SUCCESS_COPY)).not.toBeInTheDocument();

    // The message is tied to the field for screen readers, not just painted near it.
    const field = screen.getByLabelText('شماره موبایل همکار');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(
      screen.getByText('شماره موبایل معتبر نیست.').getAttribute('id'),
    );
  });

  it('keeps a network or server failure an error, never a neutral success', async () => {
    mockApi({ invite: () => refusal(500, 'INTERNAL_ERROR', 'خطایی رخ داد.') });
    await renderBusiness();
    await invite('09121234567');

    await waitFor(() => expect(screen.getByText('خطایی رخ داد.')).toBeInTheDocument());
    expect(screen.queryByText(SUCCESS_COPY)).not.toBeInTheDocument();
    expect((screen.getByLabelText('شماره موبایل همکار') as HTMLInputElement).value).toBe('09121234567');
  });
});

describe('submission discipline', () => {
  it('prevents a second submission while the first is still open', async () => {
    let release: (() => void) | null = null;
    mockApi({
      invite: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 202, json: async () => ({ data: {}, meta: null, error: null }) });
        }),
    });
    await renderBusiness();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('شماره موبایل همکار'), '09121234567');
    const button = screen.getByRole('button', { name: 'ارسال دعوت' });

    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    await user.click(button);

    expect(calls(STAFF_ROUTE, 'POST')).toHaveLength(1);

    release!();
    await waitFor(() => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument());
    // Non-vacuity: releasing really did complete the one in-flight request.
    expect(calls(STAFF_ROUTE, 'POST')).toHaveLength(1);
  });

  it('clears the field only after a success', async () => {
    mockApi();
    await renderBusiness();
    await invite('09121234567');

    await waitFor(() => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument());
    expect((screen.getByLabelText('شماره موبایل همکار') as HTMLInputElement).value).toBe('');
  });
});

describe('the removed membership status', () => {
  it('renders its Persian label and never blank text', async () => {
    mockApi({ staff: [member({ status: 'removed' })] });
    await renderBusiness();

    await waitFor(() => expect(screen.getByText('حذف‌شده')).toBeInTheDocument());
    expect(screen.getByText('حذف‌شده').textContent?.trim()).not.toBe('');
  });

  it('still renders every pre-existing status, so the map was extended and not replaced', async () => {
    mockApi({
      staff: [
        member({ id: 's1', userId: 'u2', status: 'active' }),
        member({ id: 's2', userId: 'u3', status: 'invited' }),
        member({ id: 's3', userId: 'u4', status: 'inactive' }),
        member({ id: 's4', userId: 'u5', status: 'declined' }),
        member({ id: 's5', userId: 'u6', status: 'removed' }),
      ],
    });
    await renderBusiness();

    for (const label of ['فعال', 'دعوت‌شده', 'غیرفعال', 'رد شده', 'حذف‌شده']) {
      await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
    }
  });
});

describe('no inviter-side lookup surface was added', () => {
  it('reads pending invitations only from the invitee’s own membership route', async () => {
    mockApi();
    await renderBusiness();
    await invite('09121234567');
    await waitFor(() => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument());

    const urls = allUrls();
    // Non-vacuity: the invitee's own route really is being used.
    expect(urls.some((u) => u.includes('/v1/me/business-staff'))).toBe(true);
    // And nothing that could resolve a phone to an account.
    for (const forbidden of ['/users?', 'find-user', 'lookup', 'search', 'by-phone', 'directory', 'contacts']) {
      expect(urls.some((u) => u.includes(forbidden))).toBe(false);
    }
  });
});

describe('the contract cannot be quietly reverted (static)', () => {
  const root = join(__dirname, '..');
  const page = readFileSync(join(root, 'app/business/page.tsx'), 'utf8');
  const client = readFileSync(join(root, 'lib/phase4-api.ts'), 'utf8');

  /** Comments legitimately NAME what the code must not do, so they are stripped first. */
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
    expect(pageCode).toContain('function InviteForm');
    expect(clientCode).toContain('export function inviteStaff');
  });

  it('the invite wrapper accepts a phone and types the response as carrying nothing', () => {
    const start = clientCode.indexOf('export function inviteStaff');
    // Bounded at the next top-level declaration, so later functions that
    // legitimately use `BusinessStaffMember` are not attributed to this one.
    const next = clientCode.indexOf('export function', start + 1);
    const wrapper = clientCode.slice(start, next === -1 ? undefined : next);
    expect(wrapper).toContain('phone: string');
    expect(wrapper).toContain('StaffInvitationAccepted');
    // The old row type must not be what an empty body is parsed into.
    expect(wrapper).not.toContain('BusinessStaffMember');
    expect(clientCode).toContain('export type StaffInvitationAccepted = Record<string, never>;');
  });

  it('no legacy identity selector survives anywhere in the invite path', () => {
    const inviteForm = pageCode.slice(pageCode.indexOf('function InviteForm'));
    for (const forbidden of ['userId', 'professionalId', 'user_id', 'professional_id']) {
      expect(inviteForm).not.toContain(forbidden);
    }
    // `handleInvite` must not accept one either.
    const handler = pageCode.slice(pageCode.indexOf('async function handleInvite'));
    expect(handler.slice(0, 400)).toContain('phone: string');
    expect(handler.slice(0, 400)).not.toContain('userId');
  });

  it('the phone never reaches a log, an analytics call or a metric label', () => {
    const inviteForm = pageCode.slice(pageCode.indexOf('function InviteForm'));
    for (const sink of ['console.', 'track(', 'analytics', 'gtag', 'metric', 'Sentry']) {
      expect(inviteForm).not.toContain(sink);
    }
  });

  it('the scans are non-vacuous — each forbidden shape is caught when planted', () => {
    expect(code('const x = { userId: id };')).toContain('userId');
    expect(code('console.log(phone);')).toContain('console.');
    expect(code('return api.post<BusinessStaffMember>(path, body);')).toContain('BusinessStaffMember');
    // …and an innocent line is not flagged.
    expect(code('const entered = normalizeDigits(phone.trim());')).not.toContain('userId');
  });
});
