import { render, screen } from '@testing-library/react';
import { AdminShell } from '@/components/admin-shell';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

let pathname = '/admin';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => pathname,
}));

/**
 * `25_MOBILE_NAVIGATION.md`: admin's nav is a dark bar that scrolls
 * horizontally at narrow widths, in place of a bottom bar -- there is no
 * viewport-conditional drawer to build. What this pins is the one thing that
 * scroll needs and did not have: landing on a deep route left the operator's
 * actual location scrolled off the visible strip, with nothing on screen
 * saying so.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

function renderShell() {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: 'اپراتور', roles: [], capabilities: ['bc_manage_platform'] });
    }
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

beforeEach(() => {
  pathname = '/admin';
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the admin nav scrolls the current destination into view', () => {
  it('calls scrollIntoView on the current link, and no other, once the shell knows who is signed in', async () => {
    pathname = '/admin/loyalty';
    const calls: HTMLElement[] = [];
    const spy = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      calls.push(this);
    });

    renderShell();
    await screen.findByText('اپراتور');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveAttribute('data-admin-nav', '/admin/loyalty');
    expect(calls[0]).toHaveAttribute('aria-current', 'page');
    spy.mockRestore();
  });

  it('does it again after a client-side navigation to a different destination', async () => {
    const spy = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const { rerender } = renderShell();
    await screen.findByText('اپراتور');
    spy.mockClear();

    pathname = '/admin/settlements';
    rerender(
      <AuthProvider>
        <AdminShell>
          <p>محتوا</p>
        </AdminShell>
      </AuthProvider>,
    );

    expect(spy).toHaveBeenCalled();
    const target = spy.mock.instances.at(-1) as unknown as HTMLElement;
    expect(target).toHaveAttribute('data-admin-nav', '/admin/settlements');
    spy.mockRestore();
  });

  it('never calls it for a link that is not the current one', async () => {
    pathname = '/admin/loyalty';
    const spy = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderShell();
    await screen.findByText('اپراتور');

    const targeted = spy.mock.instances as unknown as HTMLElement[];
    for (const el of targeted) expect(el).toHaveAttribute('data-admin-nav', '/admin/loyalty');
    spy.mockRestore();
  });
});
