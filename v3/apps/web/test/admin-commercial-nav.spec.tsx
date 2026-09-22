import { render, screen } from '@testing-library/react';
import { AdminShell } from '@/components/admin-shell';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin',
}));

/**
 * The admin commercial destinations (#239) are offered only to an operator
 * holding `bc_manage_commercial_plans` — the capability each page requires —
 * so nobody is shown a link to a page that would refuse them.
 */

const ENTRIES = ['/admin/commercial/outcome-policy', '/admin/commercial/control-plane'];

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

function renderShell(capabilities: string[]) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'مدیر', roles: [], capabilities });
    return ok([]);
  });
  return render(
    <AuthProvider>
      <AdminShell>
        <p>محتوا</p>
      </AdminShell>
    </AuthProvider>,
  );
}

const navLink = (href: string) => document.querySelector(`[data-admin-nav="${href}"]`);

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe.each(ENTRIES)('%s', (href) => {
  it('is offered to an operator holding bc_manage_commercial_plans', async () => {
    renderShell(['bc_manage_commercial_plans']);
    await screen.findByText('مدیر');
    expect(navLink(href)).not.toBeNull();
  });

  it('is not offered without it, whatever else the operator holds', async () => {
    renderShell(['bc_manage_platform', 'bc_moderate_verification', 'bc_moderate_media', 'bc_moderate_reviews', 'bc_moderate_chat']);
    await screen.findByText('مدیر');
    expect(navLink(href)).toBeNull();
  });
});
