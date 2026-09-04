import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProProfilePage from '@/app/pro/profile/page';
import BusinessPage from '@/app/business/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro',
}));

/**
 * The client half of V3.3 #75 (`V33-DEC-021` Ruling 9).
 *
 * The server grants the seller role atomically with ownership, and never
 * rewrites an already-issued JWT. So the browser that just created a
 * professional profile is holding a token minted before its owner was a seller:
 * without a rotation it would be refused on every seller surface until that
 * token expired on its own.
 *
 * These cases pin three things, and the second and third are the ones a future
 * edit is most likely to get wrong:
 *
 *   1. creation rotates the session, through the EXISTING `/v1/auth/refresh`;
 *   2. an UPDATE does not — no role changed, and rotating on every save would
 *      churn the session for a bio edit;
 *   3. a failed rotation is never reported as a failed creation, and never
 *      re-POSTs. The profile exists; retrying would correctly `409` against it.
 */

const PROFILE = {
  id: 'prof-1',
  displayName: 'سالن آزمایشی',
  bio: '',
  cityId: null,
  specialties: [],
  verificationStatus: 'unverified',
  createdAt: new Date().toISOString(),
};

const BUSINESS = {
  id: 'biz-1',
  ownerId: 'u1',
  displayName: 'سالن من',
  bio: null,
  cityId: null,
  verificationStatus: 'unverified',
  createdAt: new Date().toISOString(),
};

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refusal(status: number, code: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message: 'خطا' } }),
  });
}

function callsTo(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    (c) => String(c[0]).includes(fragment) && (method === undefined || c[1]?.method === method),
  );
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'stale-access-token', csrfToken: 'test-csrf-token' });
});

// ---------------------------------------------------------------------------

describe('creating a professional profile rotates the session', () => {
  function mockPro(options: { hasProfile: boolean; refreshOk?: boolean } = { hasProfile: false }) {
    const { hasProfile, refreshOk = true } = options;
    let created = false;
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/v1/auth/refresh')) {
        // `AuthProvider` restores the session with a refresh on mount, so a mock
        // that always refused would leave the user unauthenticated and the page
        // never rendered -- the test would pass for the wrong reason. Only the
        // rotation that FOLLOWS creation is refused.
        if (refreshOk || !created) return ok({ accessToken: 'fresh-access-token', csrfToken: 'c' });
        return refusal(401, 'UNAUTHORIZED');
      }
      if (/\/v1\/me(\?|$)/.test(url)) {
        return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
      }
      if (url.includes('/v1/me/provider')) return ok(hasProfile ? PROFILE : null);
      if (url.includes('/v1/cities')) return ok([]);
      if (url.includes('/v1/specialties')) return ok([]);
      if (url.includes('/v1/providers')) {
        if (init?.method === 'POST') {
          created = true;
          return ok(PROFILE);
        }
        if (init?.method === 'PATCH') return ok(PROFILE);
        return ok([]);
      }
      return ok([]);
    });
  }

  function renderPro() {
    return render(
      <AuthProvider>
        <ProProvider>
          <ProProfilePage />
        </ProProvider>
      </AuthProvider>,
    );
  }

  it('refreshes after a successful creation, using the existing auth refresh route', async () => {
    mockPro({ hasProfile: false });
    const user = userEvent.setup();
    renderPro();

    await waitFor(() => expect(screen.getByLabelText('نام نمایشی')).toBeInTheDocument());
    const refreshesBefore = callsTo('/v1/auth/refresh').length;

    await user.type(screen.getByLabelText('نام نمایشی'), 'سالن آزمایشی');
    await user.click(screen.getByRole('button', { name: 'ساخت پروفایل' }));

    await waitFor(() => expect(callsTo('/v1/providers', 'POST')).toHaveLength(1));
    // The rotation happens AFTER creation and through the route that already
    // existed -- no new endpoint, no new stored artifact.
    await waitFor(() => expect(callsTo('/v1/auth/refresh').length).toBeGreaterThan(refreshesBefore));
    await waitFor(() => expect(tokenStorage.getAccessToken()).toBe('fresh-access-token'));
  });

  it('does NOT refresh when an existing profile is merely updated', async () => {
    mockPro({ hasProfile: true });
    const user = userEvent.setup();
    renderPro();

    await waitFor(() => expect(screen.getByDisplayValue('سالن آزمایشی')).toBeInTheDocument());
    const refreshesBefore = callsTo('/v1/auth/refresh').length;

    await user.click(screen.getByRole('button', { name: 'ذخیره تغییرات' }));

    await waitFor(() => expect(callsTo('/v1/providers/prof-1', 'PATCH')).toHaveLength(1));
    expect(callsTo('/v1/auth/refresh')).toHaveLength(refreshesBefore);
    expect(callsTo('/v1/providers', 'POST')).toHaveLength(0);
  });

  it('reports a stale session rather than a failed save, and never re-POSTs', async () => {
    mockPro({ hasProfile: false, refreshOk: false });
    const user = userEvent.setup();
    renderPro();

    await waitFor(() => expect(screen.getByLabelText('نام نمایشی')).toBeInTheDocument());

    await user.type(screen.getByLabelText('نام نمایشی'), 'سالن آزمایشی');
    await user.click(screen.getByRole('button', { name: 'ساخت پروفایل' }));

    await waitFor(() => expect(screen.getByText(/پروفایل شما ساخته شد/)).toBeInTheDocument());
    // The message says the profile EXISTS. Saying otherwise would push the user
    // toward a second POST that correctly conflicts with what they just made.
    expect(screen.queryByText(/ذخیره پروفایل انجام نشد/)).not.toBeInTheDocument();
    expect(callsTo('/v1/providers', 'POST')).toHaveLength(1);
  });
});

describe('creating a business rotates the session', () => {
  function mockBusiness(options: { refreshOk?: boolean } = {}) {
    const { refreshOk = true } = options;
    let created = false;
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/v1/auth/refresh')) {
        // Same reasoning as the professional block above: the mount-time
        // restore must succeed or nothing renders.
        if (refreshOk || !created) return ok({ accessToken: 'fresh-access-token', csrfToken: 'c' });
        return refusal(401, 'UNAUTHORIZED');
      }
      if (/\/v1\/me(\?|$)/.test(url)) {
        return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
      }
      if (url.includes('/v1/me/business-staff')) return ok([]);
      if (url.includes('/v1/me/business')) return ok(created ? BUSINESS : null);
      if (url.includes('/v1/businesses') && init?.method === 'POST') {
        created = true;
        return ok(BUSINESS);
      }
      return ok([]);
    });
  }

  function renderBusiness() {
    return render(
      <AuthProvider>
        <BusinessPage />
      </AuthProvider>,
    );
  }

  it('refreshes after a successful creation', async () => {
    mockBusiness();
    const user = userEvent.setup();
    renderBusiness();

    await waitFor(() => expect(screen.getByLabelText('نام کسب‌وکار')).toBeInTheDocument());
    const refreshesBefore = callsTo('/v1/auth/refresh').length;

    await user.type(screen.getByLabelText('نام کسب‌وکار'), 'سالن من');
    await user.click(screen.getByRole('button', { name: 'ثبت کسب‌وکار' }));

    await waitFor(() => expect(callsTo('/v1/businesses', 'POST')).toHaveLength(1));
    await waitFor(() => expect(callsTo('/v1/auth/refresh').length).toBeGreaterThan(refreshesBefore));
  });

  it('never re-registers when the rotation fails: the business already exists', async () => {
    /*
     * A failed refresh is a hard sign-out by design -- `refreshSession` clears
     * the stored token and drops `status` to `unauthenticated`, so
     * `ProtectedRoute` replaces the page with the sign-in prompt. The user
     * signs in again and their next token carries the `business` role.
     *
     * What must NEVER happen is a second registration attempt, which would
     * `409` against the business created moments earlier. That is the property
     * asserted here, rather than a message the guard makes unreachable.
     */
    mockBusiness({ refreshOk: false });
    const user = userEvent.setup();
    renderBusiness();

    await waitFor(() => expect(screen.getByLabelText('نام کسب‌وکار')).toBeInTheDocument());

    await user.type(screen.getByLabelText('نام کسب‌وکار'), 'سالن من');
    await user.click(screen.getByRole('button', { name: 'ثبت کسب‌وکار' }));

    await waitFor(() => expect(callsTo('/v1/businesses', 'POST')).toHaveLength(1));
    // The creation form is gone: the session ended, so there is nothing here to
    // submit a second time.
    await waitFor(() => expect(screen.queryByLabelText('نام کسب‌وکار')).not.toBeInTheDocument());
    expect(callsTo('/v1/businesses', 'POST')).toHaveLength(1);
  });
});
