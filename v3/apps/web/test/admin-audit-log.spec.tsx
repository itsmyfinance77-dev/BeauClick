import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminAuditLogPage from '@/app/admin/audit-log/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/audit-log',
}));

/**
 * `/admin/audit-log`, against `23_ADMIN_AUDIT_LOG.md` (leave as is). What is
 * asserted here is how the log names what the server recorded: a title in
 * Persian, and — always — the exact action code, because on an audit screen the
 * precise identifier is the record.
 */

const ok = (data: unknown, meta: unknown = null) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = () => Promise.reject(new TypeError('Failed to fetch'));

const entry = (over: Record<string, unknown>) => ({
  id: 'a1',
  actorUserId: 'user-abcdef12',
  actorLabel: null,
  action: 'identity.role_granted',
  targetType: 'user',
  targetId: 'user-99999999',
  before: null,
  after: null,
  reason: null,
  correlationId: 'corr-1',
  createdAt: '2026-09-15T06:30:00.000Z',
  ...over,
});

function mockApi(entries: unknown[], actions: string[] = [], log?: () => Promise<unknown>) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities: ['bc_manage_platform'] });
    if (url.includes('/v1/admin/audit-log/actions')) return ok(actions);
    if (url.includes('/v1/admin/audit-log')) return log ? log() : ok(entries, { pagination: { page: 1, limit: 25, total: entries.length } });
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminAuditLogPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('an entry’s title', () => {
  it('names a commercial-policy change in Persian, with the exact code beneath it', async () => {
    mockApi([entry({ id: 'a1', action: 'commercial.plan_version_published', targetType: 'plan' })]);
    renderPage();
    const item = (await screen.findByText('انتشار نسخهٔ طرح')).closest('li') as HTMLElement;
    expect(within(item).getByText('commercial.plan_version_published')).toHaveAttribute('class', expect.stringContaining('id'));
  });

  it('gives an action it has never heard of a neutral title, never the dotted key as the title', async () => {
    mockApi([entry({ id: 'a2', action: 'commerce.something_new' })]);
    renderPage();
    const title = await screen.findByText('عملیات مدیریتی');
    const item = title.closest('li') as HTMLElement;
    // The code is still there, in its own line, so nothing is hidden from an auditor.
    expect(within(item).getByText('commerce.something_new')).toBeInTheDocument();
    expect(title.textContent).not.toContain('commerce');
  });

  it('names an unknown target type neutrally', async () => {
    mockApi([entry({ id: 'a3', targetType: 'subscription' })]);
    renderPage();
    const item = (await screen.findByText('اعطای نقش', { selector: 'p' })).closest('li') as HTMLElement;
    expect(item.textContent).toContain('مورد:');
    expect(item.textContent).not.toContain('subscription');
  });
});

describe('the filter picker', () => {
  it('lists real actions by their Persian name, and tells two unlabelled ones apart by code', async () => {
    mockApi([], ['identity.role_granted', 'commerce.new_a', 'commerce.new_b']);
    renderPage();
    const picker = (await screen.findByLabelText('فیلتر بر اساس نوع عملیات')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'اعطای نقش' });
    const names = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(names).toContain('اعطای نقش');
    expect(names).toContain('عملیات مدیریتی (commerce.new_a)');
    expect(names).toContain('عملیات مدیریتی (commerce.new_b)');
  });
});

describe('a failed load', () => {
  it('offers a retry and never claims the log is empty', async () => {
    let attempt = 0;
    mockApi([], [], () => (++attempt === 1 ? fail() : ok([entry({})], { pagination: { page: 1, limit: 25, total: 1 } })));
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(screen.queryByText('عملیاتی با این فیلتر ثبت نشده است.')).toBeNull();
    await user.click(retry);
    expect(await screen.findByText('اعطای نقش', { selector: 'p' })).toBeInTheDocument();
  });
});
