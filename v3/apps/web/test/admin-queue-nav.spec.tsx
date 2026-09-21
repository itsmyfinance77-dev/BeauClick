import { render, screen } from '@testing-library/react';
import { AdminShell } from '@/components/admin-shell';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin',
}));

/**
 * The operator queues in the admin nav (#238): each destination is offered only
 * to an operator holding the capability its page requires, so nobody is shown
 * a link to a page that would refuse them.
 */

const QUEUES = [
  { href: '/admin/media', capability: 'bc_moderate_media' },
  { href: '/admin/reviews', capability: 'bc_moderate_reviews' },
  { href: '/admin/privacy', capability: 'bc_manage_platform' },
];

/** Somebody holding every capability EXCEPT the one under test. */
const ALL = ['bc_manage_platform', 'bc_moderate_verification', 'bc_moderate_media', 'bc_moderate_reviews', 'bc_moderate_chat'];

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

function renderShell(capabilities: string[]) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities });
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

describe.each(QUEUES)('$href', ({ href, capability }) => {
  it(`is offered to an operator holding ${capability}`, async () => {
    renderShell([capability]);
    await screen.findByText('اپراتور');
    expect(navLink(href)).not.toBeNull();
  });

  it(`is not offered without ${capability}, whatever else the operator holds`, async () => {
    renderShell(ALL.filter((c) => c !== capability));
    await screen.findByText('اپراتور');
    expect(navLink(href)).toBeNull();
  });
});
