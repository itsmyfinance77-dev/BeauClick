import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminUsersPage from '@/app/admin/users/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/users',
}));

/**
 * `/admin/users`, against `22_ADMIN_USERS.md`: the role list must recover from
 * a failed load, the account card must always be the account that was
 * searched for, and a role grant needs a reason the server will accept.
 */

const ok = (data: unknown, meta: unknown = null) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code: 'ERR', message } }) });

const CATALOGUE = {
  roles: [
    { slug: 'customer', name: 'مشتری', description: 'رزرو خدمات.', isPrivileged: false, isDefault: true },
    { slug: 'platform_operator', name: 'اپراتور پلتفرم', description: 'عملیات پلتفرم.', isPrivileged: true, isDefault: false },
  ],
  capabilities: [],
};

const ME_ID = 'u1';
const USER_A = { id: 'user-a', phone: '+989121110001', displayName: 'کاربر اول', roles: ['customer'], createdAt: '2026-09-01T00:00:00.000Z' };
const USER_B = { id: 'user-b', phone: '+989121110002', displayName: 'کاربر دوم', roles: ['customer', 'retired_role'], createdAt: '2026-09-01T00:00:00.000Z' };

function mockApi(handlers: { catalogue?: () => Promise<unknown>; users?: (url: string) => Promise<unknown>; role?: () => Promise<unknown> } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: ME_ID, phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities: ['bc_manage_platform'] });
    if (url.includes('/v1/admin/users/roles/catalogue')) return handlers.catalogue ? handlers.catalogue() : ok(CATALOGUE);
    if (url.includes('/v1/admin/users?')) return handlers.users ? handlers.users(url) : ok([USER_A], { pagination: { page: 1, limit: 1, total: 1 } });
    if (/\/v1\/admin\/users\/[^/]+\/roles/.test(url)) return handlers.role ? handlers.role() : ok({ roles: ['customer', 'platform_operator'] });
    return ok([]);
  });
}

function calls(fragment: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
}

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminUsersPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

async function search(user: ReturnType<typeof userEvent.setup>, phone: string) {
  const field = await screen.findByLabelText('شماره موبایل کاربر');
  await user.clear(field);
  await user.type(field, phone);
  await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the role list', () => {
  it('offers a retry when it fails to load, instead of a spinner that never ends', async () => {
    let attempt = 0;
    mockApi({ catalogue: () => (++attempt === 1 ? fail(500, 'خطای سرور') : ok(CATALOGUE)) });
    const user = userEvent.setup();
    renderPage();
    await search(user, '09121110001');

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(screen.queryByText('در حال بارگذاری فهرست نقش‌ها…')).toBeNull();
    await user.click(retry);
    expect(await screen.findByText('اپراتور پلتفرم')).toBeInTheDocument();
    expect(calls('/roles/catalogue')).toHaveLength(2);
  });

  it('names an account’s role by the catalogue’s name, and never by its database key', async () => {
    mockApi({ users: () => ok([USER_B], { pagination: { page: 1, limit: 1, total: 1 } }) });
    const user = userEvent.setup();
    renderPage();
    await search(user, '09121110002');

    const card = (await screen.findByLabelText('حساب یافت‌شده')) as HTMLElement;
    expect(within(card).getAllByText('مشتری').length).toBeGreaterThan(0);
    expect(within(card).getByText('نقش ناشناخته')).toBeInTheDocument();
    expect(card.textContent).not.toContain('retired_role');
  });

  it('cannot grant an administrative role to your own account', async () => {
    mockApi({ users: () => ok([{ ...USER_A, id: ME_ID }], { pagination: { page: 1, limit: 1, total: 1 } }) });
    const user = userEvent.setup();
    renderPage();
    await search(user, '09121110001');
    await screen.findByText('اپراتور پلتفرم');
    const row = screen.getByText('اپراتور پلتفرم').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'اعطا' })).toBeDisabled();
    expect(screen.getByText(/این حساب خود شماست/)).toBeInTheDocument();
  });
});

describe('the search', () => {
  it('asks for a number rather than sending an empty one', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'جست‌وجو' }));
    expect(await screen.findByText('شماره موبایل کاربر را وارد کنید.')).toBeInTheDocument();
    expect(calls('/v1/admin/users?')).toHaveLength(0);
  });

  it('never leaves the previous account on screen when the next search fails', async () => {
    let attempt = 0;
    mockApi({ users: () => (++attempt === 1 ? ok([USER_A], { pagination: { page: 1, limit: 1, total: 1 } }) : fail(500, 'جست‌وجو انجام نشد.')) });
    const user = userEvent.setup();
    renderPage();
    await search(user, '09121110001');
    expect(await screen.findByText('کاربر اول')).toBeInTheDocument();

    await search(user, '09121110002');
    expect(await screen.findByText('جست‌وجو انجام نشد.')).toBeInTheDocument();
    expect(screen.queryByText('کاربر اول')).toBeNull();
    expect(screen.queryByLabelText('حساب یافت‌شده')).toBeNull();
  });
});

describe('a role change', () => {
  async function openGrant(user: ReturnType<typeof userEvent.setup>) {
    renderPage();
    await search(user, '09121110001');
    const row = (await screen.findByText('اپراتور پلتفرم')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'اعطا' }));
    return screen.findByRole('dialog');
  }

  it('waits for a reason of at least four characters after trimming, and says so', async () => {
    mockApi();
    const user = userEvent.setup();
    const dialog = await openGrant(user);
    const confirm = within(dialog).getByRole('button', { name: 'اعطا کن' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('دلیل'), 'ab  ');
    expect(within(dialog).getByText('دلیل باید حداقل ۴ نویسه باشد.')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('دلیل'), 'cd');
    expect(confirm).toBeEnabled();
    expect(calls('/roles')).toHaveLength(1); // the catalogue read only — nothing sent
  });

  it('updates the account’s roles and says what happened', async () => {
    mockApi();
    const user = userEvent.setup();
    const dialog = await openGrant(user);
    await user.type(within(dialog).getByLabelText('دلیل'), 'اپراتور جدید');
    await user.click(within(dialog).getByRole('button', { name: 'اعطا کن' }));

    expect(await screen.findByText('نقش «اپراتور پلتفرم» اعطا شد.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = screen.getByText('اپراتور پلتفرم', { selector: 'p' }).closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'لغو' })).toBeInTheDocument();
  });
});
