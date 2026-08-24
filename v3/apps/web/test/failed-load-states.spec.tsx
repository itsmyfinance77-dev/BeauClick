import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationsPage from '@/app/notifications/page';
import WaitlistPage from '@/app/waitlist/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

/**
 * A page whose data request FAILED must not claim the user has nothing.
 *
 * "هنوز اعلانی ندارید" is an assertion about the server's answer. When there
 * was no answer, making it anyway sends the user off to solve the wrong
 * problem -- and, since several of these strings sit in live regions, says
 * the wrong thing to a screen reader too. Both of these pages did exactly
 * that: a failed load leaves the same empty array a genuinely-empty response
 * does, and the empty state was keyed only on `length === 0`.
 */

/** Signs the app in without a network round-trip, so the page under test actually mounts. */
function authenticate() {
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
}

function mockSessionRestoreThenFailure() {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    // Session restore: refresh + /v1/me succeed, so `status` reaches
    // 'authenticated' and ProtectedRoute renders its children.
    if (url.includes('/v1/auth/refresh')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { accessToken: 'a', csrfToken: 'c' }, meta: null, error: null }),
      });
    }
    // Exactly the profile endpoint -- NOT the many /v1/me/* resource paths
    // (/v1/me/notifications, /v1/me/waitlist) that the pages themselves call.
    if (/\/v1\/me(\?|$)/.test(url)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] },
          meta: null,
          error: null,
        }),
      });
    }
    // Everything the PAGE itself asks for fails, which is the case under test.
    return Promise.reject(new TypeError('Failed to fetch'));
  });
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
});

describe('Notifications — failed load', () => {
  it('shows the failure and a retry, never the "you have no notifications" empty state', async () => {
    authenticate();
    mockSessionRestoreThenFailure();

    render(
      <AuthProvider>
        <UnreadProvider>
          <NotificationsPage />
        </UnreadProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // The regression this test exists for.
    expect(screen.queryByText('هنوز اعلانی ندارید.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });

  it('retry re-issues the request rather than being a decorative button', async () => {
    authenticate();
    mockSessionRestoreThenFailure();
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <UnreadProvider>
          <NotificationsPage />
        </UnreadProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument());

    const before = (global.fetch as jest.Mock).mock.calls.filter(([u]: [string]) =>
      String(u).includes('/v1/me/notifications'),
    ).length;

    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => {
      const after = (global.fetch as jest.Mock).mock.calls.filter(([u]: [string]) =>
        String(u).includes('/v1/me/notifications'),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe('Waitlist — failed load', () => {
  it('does not claim the user is on no waitlists when the request failed', async () => {
    authenticate();
    mockSessionRestoreThenFailure();

    render(
      <AuthProvider>
        <UnreadProvider>
          <WaitlistPage />
        </UnreadProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    expect(screen.queryByText('در حال حاضر در هیچ لیست انتظاری قرار ندارید.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});
