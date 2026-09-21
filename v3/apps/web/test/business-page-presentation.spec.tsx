import { render, screen, waitFor, within } from '@testing-library/react';
import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/business',
}));

/**
 * The business page, against `12_BUSINESS.md` and `45_OWNER_FINANCE_ACCESS.md`.
 *
 * The page's authority behaviour (grant, revoke, the acknowledgement, the
 * announcements) is covered by `business-finance-access.spec.tsx` and is
 * unchanged. What is asserted here is how it names what the server sends and
 * how its sections are arranged.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

const BUSINESS = {
  id: 'biz-1',
  ownerId: 'u1',
  displayName: 'سالن من',
  bio: 'میکاپ و مو',
  cityId: null,
  verificationStatus: 'unverified',
  createdAt: '2026-08-01T08:30:00.000Z',
};

const member = (over: Record<string, unknown>) => ({
  id: 'm1',
  role: 'staff',
  status: 'active',
  displayLabel: 'سارا رضایی',
  labelSource: 'professional',
  identificationHint: '0002',
  roles: [] as string[],
  ...over,
});

function mockApi(opts: { members?: unknown[]; memberships?: unknown[]; owned?: boolean } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['business'], capabilities: [] });
    if (url.includes('/v1/me/business-staff')) return ok(opts.memberships ?? []);
    if (url.includes('/v1/me/business')) return ok(opts.owned === false ? null : BUSINESS);
    if (url.includes('/staff-management')) return ok({ items: opts.members ?? [] });
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <BusinessPage />
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-member="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('membership statuses', () => {
  it('shows a word for every status the server has — an erased member’s badge is not blank', async () => {
    mockApi({
      members: [
        member({ id: 'm1', status: 'active' }),
        member({ id: 'm2', status: 'invited' }),
        member({ id: 'm3', status: 'removed' }),
        member({ id: 'm4', status: 'declined' }),
        member({ id: 'm5', status: 'inactive' }),
      ],
    });
    renderPage();
    await screen.findByText('اعضای کسب‌وکار');
    expect(within(row('m1')).getByText('فعال')).toBeInTheDocument();
    expect(within(row('m2')).getByText('دعوت‌شده')).toBeInTheDocument();
    expect(within(row('m3')).getByText('حذف‌شده')).toBeInTheDocument();
    expect(within(row('m4')).getByText('رد شده')).toBeInTheDocument();
    expect(within(row('m5')).getByText('غیرفعال')).toBeInTheDocument();
  });

  it('shows a neutral word for a status it has never heard of, not a blank badge', async () => {
    mockApi({ members: [member({ id: 'm1', status: 'suspended' })] });
    renderPage();
    await screen.findByText('اعضای کسب‌وکار');
    expect(within(row('m1')).getByText('نامشخص')).toBeInTheDocument();
    expect(row('m1').textContent).not.toContain('suspended');
  });

  it('names each role in Persian, and never leaves an unknown one blank', async () => {
    mockApi({ members: [member({ id: 'm1', role: 'manager' }), member({ id: 'm2', role: 'owner' })] });
    renderPage();
    await screen.findByText('اعضای کسب‌وکار');
    expect(within(row('m1')).getByText('مدیر')).toBeInTheDocument();
    expect(within(row('m2')).getByText('عضو')).toBeInTheDocument();
    expect(row('m2').textContent).not.toContain('owner');
  });
});

describe('invitations', () => {
  it('names the role an invitation is for, and stays a labelled section of its own', async () => {
    mockApi({ memberships: [{ id: 'inv-1', businessId: 'biz-9', userId: 'u1', role: 'manager', status: 'invited', createdAt: '2026-09-01T00:00:00.000Z' }] });
    renderPage();
    expect(await screen.findByText('دعوت به عنوان مدیر')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'دعوت‌های شما' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'پذیرفتن' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'رد کردن' })).toBeInTheDocument();
  });

  it('puts the invitations before the business and its roster — a decision waiting on the user is not below a long list', async () => {
    mockApi({
      memberships: [{ id: 'inv-1', businessId: 'biz-9', userId: 'u1', role: 'staff', status: 'invited', createdAt: '2026-09-01T00:00:00.000Z' }],
      members: [member({})],
    });
    renderPage();
    const invites = await screen.findByRole('heading', { name: 'دعوت‌های شما' });
    const roster = screen.getByRole('heading', { name: 'اعضای کسب‌وکار' });
    expect(invites.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the identity line', () => {
  it('frames a phone-labelled member — four bare digits are not a name — and isolates the digits left-to-right', async () => {
    mockApi({ members: [member({ id: 'm1', labelSource: 'phone', displayLabel: '0002', identificationHint: '0002' })] });
    renderPage();
    await screen.findByText('اعضای کسب‌وکار');
    const digits = within(row('m1')).getByText('0002');
    expect(digits).toHaveAttribute('dir', 'ltr');
    expect(digits.className).toContain('hintDigits');
    expect(row('m1').textContent).toContain('شمارهٔ منتهی به');
  });
});

describe('the sections', () => {
  it('shows the create-a-business form only when the user has no business and no membership', async () => {
    mockApi({ owned: false });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'ثبت کسب‌وکار جدید' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'اعضای کسب‌وکار' })).toBeNull();
  });

  it('shows the business and its roster in two panels inside one column group', async () => {
    mockApi({ members: [member({})] });
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'سالن من' })).toBeInTheDocument());
    const columns = screen.getByRole('heading', { name: 'سالن من' }).closest('[class*=columns]') as HTMLElement;
    expect(columns).not.toBeNull();
    expect(within(columns).getByRole('heading', { name: 'اعضای کسب‌وکار' })).toBeInTheDocument();
  });
});
