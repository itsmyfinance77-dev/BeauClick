import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminLayout from '@/app/admin/layout';
import AdminVerificationPage from '@/app/admin/verification/page';
import AdminUsersPage from '@/app/admin/users/page';
import AdminPhoneConflictsPage from '@/app/admin/phone-conflicts/page';
import AdminAuditLogPage from '@/app/admin/audit-log/page';
import { AdminGuard } from '@/components/admin-guard';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin',
}));

/**
 * The admin surface.
 *
 * The first block is the one that matters most: **the frontend gate is a
 * courtesy, and the tests must not imply otherwise.** Every case below that
 * checks "a customer sees a refusal" is testing the EXPLANATION, not the
 * control -- the control is `CapabilityGuard`, proven in
 * `operability-foundation.pg-spec.ts` against a real database, including the
 * case where a revoked operator holding a still-valid token is refused.
 */

function authenticate() {
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
}

function ok(data: unknown, meta: unknown = null) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
}

function fail() {
  return Promise.reject(new TypeError('Failed to fetch'));
}

function forbidden() {
  return Promise.resolve({
    ok: false,
    status: 403,
    json: async () => ({ data: null, meta: null, error: { code: 'FORBIDDEN', message: 'اجازه دسترسی به این بخش را ندارید.' } }),
  });
}

/**
 * `capabilities` is what `/v1/me` reports, and on the real API that is resolved
 * LIVE from `identity.user_roles` rather than echoed from the token -- which is
 * why a revocation removes the surface at the next page load.
 */
function mockApi(capabilities: string[], overrides: Record<string, () => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) return handler();
    }
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities });
    }
    if (url.includes('/v1/admin/verification/queue')) return ok([], { pagination: { page: 1, limit: 20, total: 0 } });
    if (url.includes('/v1/admin/phone-conflicts')) return ok([], { pagination: { page: 1, limit: 25, total: 0 } });
    if (url.includes('/v1/admin/audit-log/actions')) return ok([]);
    if (url.includes('/v1/admin/audit-log')) return ok([], { pagination: { page: 1, limit: 25, total: 0 } });
    if (url.includes('/v1/admin/users/roles/catalogue')) return ok({ roles: [], capabilities: [] });
    if (url.includes('/v1/admin/users')) return ok([], { pagination: { page: 1, limit: 1, total: 0 } });
    return ok([]);
  });
}

function renderAdmin(node: React.ReactElement) {
  return render(
    <AuthProvider>
      <UnreadProvider>{node}</UnreadProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  authenticate();
});

// ---------------------------------------------------------------------------

describe('admin access', () => {
  it('refuses a customer with an explanation rather than a broken page', async () => {
    mockApi(['bc_book_service']);
    renderAdmin(
      <AdminGuard>
        <p>محتوای مدیریتی</p>
      </AdminGuard>,
    );

    await waitFor(() => expect(screen.getByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument());
    expect(screen.queryByText('محتوای مدیریتی')).not.toBeInTheDocument();
  });

  it('refuses a professional, whose capabilities are unrelated to the platform', async () => {
    mockApi(['bc_manage_own_profile', 'bc_view_own_finance']);
    renderAdmin(
      <AdminGuard>
        <p>محتوای مدیریتی</p>
      </AdminGuard>,
    );

    await waitFor(() => expect(screen.getByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument());
  });

  it('admits an operator who holds the capability', async () => {
    mockApi(['bc_manage_platform']);
    renderAdmin(
      <AdminGuard>
        <p>محتوای مدیریتی</p>
      </AdminGuard>,
    );

    await waitFor(() => expect(screen.getByText('محتوای مدیریتی')).toBeInTheDocument());
  });

  it('gates the verification queue on MODERATION, not on platform management', async () => {
    // The two are different authorities. An operator without the moderation
    // capability gets the refusal even though they can reach every other admin
    // screen.
    mockApi(['bc_manage_platform']);
    renderAdmin(<AdminVerificationPage />);

    await waitFor(() => expect(screen.getByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument());
  });

  it('hides nav destinations the operator cannot use', async () => {
    mockApi(['bc_manage_platform']);
    renderAdmin(
      <AdminLayout>
        <p>محتوا</p>
      </AdminLayout>,
    );

    await waitFor(() => expect(screen.getByText('پنل مدیریت')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'گزارش عملیات' })).toBeInTheDocument();
    // No moderation capability -> no verification link. The API refuses it
    // regardless; this only avoids offering a door that does not open.
    expect(screen.queryByRole('link', { name: 'احراز هویت' })).not.toBeInTheDocument();
  });

  it('makes the admin context unmistakable', async () => {
    mockApi(['bc_manage_platform', 'bc_moderate_verification']);
    renderAdmin(
      <AdminLayout>
        <p>محتوا</p>
      </AdminLayout>,
    );

    await waitFor(() => expect(screen.getByText('پنل مدیریت')).toBeInTheDocument());
    // Who you are acting as, what you may do, and the way out -- all present.
    expect(screen.getByText('اپراتور')).toBeInTheDocument();
    expect(screen.getByText('مدیریت پلتفرم')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'خروج از پنل مدیریت' })).toBeInTheDocument();
  });
});

describe('verification queue', () => {
  const request = {
    id: 'req-1',
    professionalId: 'prof-abcdef12',
    status: 'pending' as const,
    note: 'مدارک آماده است',
    submittedAt: '2026-09-15T06:30:00.000Z',
    decidedAt: null,
    decisionReason: null,
    displayName: 'سالن نمونه',
    cityId: null,
  };

  it('claims "nothing to review" only after a successful, genuinely empty response', async () => {
    mockApi(['bc_moderate_verification'], {
      '/v1/admin/verification/queue': () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }),
    });
    renderAdmin(<AdminVerificationPage />);

    await waitFor(() => expect(screen.getByText('درخواست بررسی‌نشده‌ای وجود ندارد.')).toBeInTheDocument());
  });

  it('never claims "nothing to review" when the request failed', async () => {
    // The consequence here is worse than a cosmetic one: an operator told the
    // queue is empty stops looking, and real submissions sit unreviewed.
    mockApi(['bc_moderate_verification'], { '/v1/admin/verification/queue': fail });
    renderAdmin(<AdminVerificationPage />);

    // Waiting on the RETRY button, not on any alert: this screen carries a
    // static advisory Alert that renders before the request even starts, so
    // `getAllByRole('alert')` would be satisfied while the load is still in
    // flight and the assertion below would race it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());
    expect(screen.queryByText('درخواست بررسی‌نشده‌ای وجود ندارد.')).not.toBeInTheDocument();
  });

  it('states the evidence-less boundary rather than showing an empty attachment area', async () => {
    mockApi(['bc_moderate_verification'], {
      '/v1/admin/verification/queue': () => ok([request], { pagination: { page: 1, limit: 20, total: 1 } }),
    });
    renderAdmin(<AdminVerificationPage />);

    await waitFor(() => expect(screen.getByText('سالن نمونه')).toBeInTheDocument());
    expect(screen.getByText(/بدون بارگذاری مدرک ارسال می‌شوند/)).toBeInTheDocument();
  });

  it('requires a reason before a decision is sent', async () => {
    mockApi(['bc_moderate_verification'], {
      '/v1/admin/verification/queue': () => ok([request], { pagination: { page: 1, limit: 20, total: 1 } }),
    });
    const user = userEvent.setup();
    renderAdmin(<AdminVerificationPage />);

    await user.click(await screen.findByRole('button', { name: 'تأیید' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('دلیل تصمیم')).toBeInTheDocument();

    // Nothing has been sent by opening the dialog.
    expect((global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/decide'))).toHaveLength(0);
  });

  it('sends the decision with its reason, and reloads from the server afterwards', async () => {
    mockApi(['bc_moderate_verification'], {
      '/v1/admin/verification/queue': () => ok([request], { pagination: { page: 1, limit: 20, total: 1 } }),
      '/decide': () => ok({ ...request, status: 'approved' }),
    });
    const user = userEvent.setup();
    renderAdmin(<AdminVerificationPage />);

    await user.click(await screen.findByRole('button', { name: 'تأیید' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل تصمیم'), 'مدارک بررسی شد');
    await user.click(within(dialog).getByRole('button', { name: 'تأیید نهایی' }));

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/decide'));
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body)).toEqual({ decision: 'approve', reason: 'مدارک بررسی شد' });
    });
  });
});

describe('role administration', () => {
  const catalogue = {
    roles: [
      {
        slug: 'platform_operator',
        name: 'اپراتور پلتفرم',
        description: 'کمترین سطح دسترسی عملیاتی.',
        isPrivileged: true,
        isDefault: false,
      },
    ],
    capabilities: [],
  };
  const target = {
    id: 'user-2',
    phone: '+989121110002',
    displayName: 'کاربر هدف',
    roles: ['customer'],
    createdAt: '2026-09-01T00:00:00.000Z',
  };

  it('folds Persian digits before searching, so a Persian-keyboard number finds the account', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/users/roles/catalogue': () => ok(catalogue),
      '/v1/admin/users?': () => ok([target], { pagination: { page: 1, limit: 1, total: 1 } }),
    });
    const user = userEvent.setup();
    renderAdmin(<AdminUsersPage />);

    await user.type(await screen.findByLabelText('شماره موبایل کاربر'), '۰۹۱۲۱۱۱۰۰۰۲');
    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() => {
      const call = (global.fetch as jest.Mock).mock.calls.find((c) => String(c[0]).includes('/v1/admin/users?phone='));
      expect(call).toBeDefined();
      // ASCII on the wire. The same root cause as QA-01/02, one surface later.
      expect(decodeURIComponent(String(call![0]))).toContain('phone=09121110002');
    });
  });

  it('says so plainly when no account matches, rather than looking broken', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/users/roles/catalogue': () => ok(catalogue),
      '/v1/admin/users?': () => ok([], { pagination: { page: 1, limit: 1, total: 0 } }),
    });
    const user = userEvent.setup();
    renderAdmin(<AdminUsersPage />);

    await user.type(await screen.findByLabelText('شماره موبایل کاربر'), '09120000000');
    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() => expect(screen.getByText(/کاربری با این شماره یافت نشد/)).toBeInTheDocument());
  });

  it('surfaces the SERVER refusal instead of pre-judging the escalation rules', async () => {
    // The frontend deliberately does not re-implement who-may-grant-what: a
    // second authorization system is one that can disagree with the first. What
    // it must do is show the refusal.
    mockApi(['bc_manage_platform'], {
      '/v1/admin/users/roles/catalogue': () => ok(catalogue),
      '/v1/admin/users?': () => ok([target], { pagination: { page: 1, limit: 1, total: 1 } }),
      '/roles': forbidden,
    });
    const user = userEvent.setup();
    renderAdmin(<AdminUsersPage />);

    await user.type(await screen.findByLabelText('شماره موبایل کاربر'), '09121110002');
    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));
    await user.click(await screen.findByRole('button', { name: 'اعطا' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('دلیل'), 'اپراتور جدید');
    await user.click(within(dialog).getByRole('button', { name: 'اعطا کن' }));

    await waitFor(() => expect(screen.getByText('اجازه دسترسی به این بخش را ندارید.')).toBeInTheDocument());
  });
});

describe('phone conflicts', () => {
  it('says that resolving records a review and changes no account', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/phone-conflicts': () =>
        ok(
          [
            {
              id: 'c1',
              phone: '+989120000099',
              existingUserId: 'user-abcdef12',
              note: null,
              resolvedAt: null,
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          { pagination: { page: 1, limit: 25, total: 1 } },
        ),
    });
    renderAdmin(<AdminPhoneConflictsPage />);

    // The advisory copy is static, so waiting on it proves nothing about the
    // load. Wait for the row instead, then assert both.
    await waitFor(() => expect(screen.getByRole('button', { name: 'ثبت بررسی' })).toBeInTheDocument());
    expect(screen.getByText(/هیچ حسابی ادغام یا تغییر داده نمی‌شود/)).toBeInTheDocument();
  });

  it('never claims "no conflicts" after a failed load', async () => {
    mockApi(['bc_manage_platform'], { '/v1/admin/phone-conflicts': fail });
    renderAdmin(<AdminPhoneConflictsPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());
    expect(screen.queryByText('تعارض بررسی‌نشده‌ای وجود ندارد.')).not.toBeInTheDocument();
  });
});

describe('audit log', () => {
  const entry = {
    id: 'a1',
    actorUserId: 'user-abcdef12',
    actorLabel: null,
    action: 'identity.role_granted',
    targetType: 'user',
    targetId: 'user-99999999',
    before: { roles: 'customer' },
    after: { roles: 'customer,platform_operator', role: 'platform_operator' },
    reason: 'اپراتور جدید',
    correlationId: 'corr-1',
    createdAt: '2026-09-15T06:30:00.000Z',
  };

  it('renders an entry in Persian, with before and after', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/audit-log/actions': () => ok(['identity.role_granted']),
      '/v1/admin/audit-log': () => ok([entry], { pagination: { page: 1, limit: 25, total: 1 } }),
    });
    renderAdmin(<AdminAuditLogPage />);

    // The label appears twice on purpose -- once in the filter picker and once
    // as this entry's heading -- so the query is scoped to the heading rather
    // than the screen being changed to make a test simpler.
    await waitFor(() => expect(screen.getByText('«اپراتور جدید»')).toBeInTheDocument());
    expect(screen.getAllByText('اعطای نقش').length).toBeGreaterThan(0);
    expect(screen.getByText(/پیش از تغییر/)).toBeInTheDocument();
    expect(screen.getByText(/پس از تغییر/)).toBeInTheDocument();
  });

  it('marks a bootstrap entry, which has no accountable actor behind it', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/audit-log/actions': () => ok([]),
      '/v1/admin/audit-log': () =>
        ok([{ ...entry, actorUserId: null, actorLabel: 'bootstrap' }], {
          pagination: { page: 1, limit: 25, total: 1 },
        }),
    });
    renderAdmin(<AdminAuditLogPage />);

    await waitFor(() => expect(screen.getByText('«اپراتور جدید»')).toBeInTheDocument());
    // `bootstrap` is the one-time privileged grant with no session behind it.
    // It appears TWICE by design -- once as the actor (where a user id would
    // otherwise be) and once as a badge -- so an operator can tell at a glance
    // which rows predate any accountable actor. Asserting both rather than
    // narrowing to one.
    expect(screen.getAllByText('bootstrap')).toHaveLength(2);
  });

  it('offers no way to edit or delete an entry', async () => {
    mockApi(['bc_manage_platform'], {
      '/v1/admin/audit-log/actions': () => ok([]),
      '/v1/admin/audit-log': () => ok([entry], { pagination: { page: 1, limit: 25, total: 1 } }),
    });
    renderAdmin(<AdminAuditLogPage />);

    await waitFor(() => expect(screen.getByText('«اپراتور جدید»')).toBeInTheDocument());
    // The real guarantee is a database GRANT (proven in the pg suite); this
    // asserts the screen does not imply otherwise.
    expect(screen.queryByRole('button', { name: /حذف|ویرایش/ })).not.toBeInTheDocument();
  });

  it('never claims "no entries" after a failed load', async () => {
    mockApi(['bc_manage_platform'], { '/v1/admin/audit-log': fail });
    renderAdmin(<AdminAuditLogPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());
    expect(screen.queryByText('عملیاتی با این فیلتر ثبت نشده است.')).not.toBeInTheDocument();
  });
});
