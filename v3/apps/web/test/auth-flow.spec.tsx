import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthPage from '@/app/auth/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

const replace = jest.fn();
/**
 * `useSearchParams` was added to this mock in V3.1 Phase F, when the auth page
 * gained `?next=` support so a customer sent here from the checkout result
 * comes BACK to it after signing in.
 *
 * Empty params, so every case below still asserts the DEFAULT destination —
 * the `next` behaviour itself is covered by `safe-return.spec.ts` (the
 * open-redirect boundary) and by the checkout result suite (the link it
 * builds).
 */
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function renderAuthPage() {
  return render(
    <AuthProvider>
      <AuthPage />
    </AuthProvider>,
  );
}

describe('Auth flow (OTP request -> verify -> session)', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    replace.mockClear();
    tokenStorage.clear();
  });

  it('requests an OTP and advances to the code step', async () => {
    const user = userEvent.setup();
    renderAuthPage();

    mockFetchOnce(200, { data: { requested: true }, meta: null, error: null });

    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));

    await waitFor(() => expect(screen.getByLabelText('کد تأیید')).toBeInTheDocument());

    const calls = (global.fetch as jest.Mock).mock.calls as Array<[string, RequestInit]>;

    // The FIRST call is now the mount-time session restore (ADR-020): the app
    // tries the httpOnly refresh cookie before deciding the visitor is signed
    // out. Asserted rather than skipped over -- it is the behaviour that makes
    // a page reload keep the session.
    expect(calls[0][0]).toContain('/v1/auth/refresh');
    expect(calls[0][1].credentials).toBe('include');

    const otpCall = calls.find(([url]) => url.includes('/v1/auth/request-otp'));
    expect(otpCall).toBeDefined();
    expect(JSON.parse(otpCall![1].body as string)).toEqual({ phone: '09123456789', purpose: 'login' });
    // The OTP request is made by the ordinary client, which cannot send the
    // refresh cookie at all.
    expect(otpCall![1].credentials).toBe('omit');
  });

  it('verifies the code, stores the session, and redirects to the dashboard', async () => {
    const user = userEvent.setup();
    renderAuthPage();

    mockFetchOnce(200, { data: { requested: true }, meta: null, error: null });
    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await waitFor(() => expect(screen.getByLabelText('کد تأیید')).toBeInTheDocument());

    mockFetchOnce(200, {
      data: {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        user: { id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'] },
      },
      meta: null,
      error: null,
    });

    await user.type(screen.getByLabelText('کد تأیید'), '123456');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(tokenStorage.getAccessToken()).toBe('access-tok');
    expect(tokenStorage.isAuthenticated()).toBe(true);
  });

  it("shows the SERVER's Persian error message verbatim on an invalid code (never client-invented copy)", async () => {
    const user = userEvent.setup();
    renderAuthPage();

    mockFetchOnce(200, { data: { requested: true }, meta: null, error: null });
    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await waitFor(() => expect(screen.getByLabelText('کد تأیید')).toBeInTheDocument());

    mockFetchOnce(400, {
      data: null,
      meta: null,
      error: { code: 'VALIDATION_ERROR', message: 'کد وارد شده نامعتبر یا منقضی شده است.' },
    });

    await user.type(screen.getByLabelText('کد تأیید'), '000000');
    await user.click(screen.getByRole('button', { name: 'تأیید و ورود' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('کد وارد شده نامعتبر یا منقضی شده است.');
    expect(tokenStorage.isAuthenticated()).toBe(false); // no session created on failure
    expect(replace).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit error without creating a session', async () => {
    const user = userEvent.setup();
    renderAuthPage();

    mockFetchOnce(429, {
      data: null,
      meta: null,
      error: { code: 'RATE_LIMITED', message: 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.' },
    });

    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.');
    expect(screen.queryByLabelText('کد تأیید')).not.toBeInTheDocument(); // stays on the phone step
  });

  it('lets the user go back and correct the phone number', async () => {
    const user = userEvent.setup();
    renderAuthPage();

    mockFetchOnce(200, { data: { requested: true }, meta: null, error: null });
    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await waitFor(() => expect(screen.getByLabelText('کد تأیید')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'تغییر شماره موبایل' }));
    expect(screen.getByLabelText('شماره موبایل')).toBeInTheDocument();
  });
});
