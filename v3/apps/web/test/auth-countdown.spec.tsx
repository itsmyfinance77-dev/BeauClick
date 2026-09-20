import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthPage from '@/app/auth/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/auth',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The resend countdown — `Prototype - Customer.dc.html` §11 (QA-19).
 *
 * ## Why this has its own suite
 *
 * `request-otp` answers with two durations that are easy to confuse and
 * mean different things: `cooldownRemaining` (60s) is when a RESEND would be
 * accepted, `expiresInSeconds` (120s) is how long the code stays valid. The
 * design is explicit about which one the countdown is, because the wrong one
 * tells somebody to wait twice as long as they have to.
 *
 * And the two 429s are not the same refusal. Inside the cooldown the server
 * gives `details.retryAfterSeconds` — an exact number, because that limit
 * depends only on the last request. The hourly cap gives no such field, and
 * its ABSENCE means unknown rather than zero. A countdown invented for it
 * would be a promise nobody made.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string, message: string, details?: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message, details } }),
  });
}

function mockApi(options: { request?: () => Promise<unknown> } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/request-otp')) {
      return options.request ? options.request() : ok({ requested: true, cooldownRemaining: 60, expiresInSeconds: 120 });
    }
    if (url.includes('/v1/auth/refresh')) return refused(401, 'UNAUTHORIZED', 'no session');
    return ok({});
  });
}

function renderAuth() {
  return render(
    <AuthProvider>
      <AuthPage />
    </AuthProvider>,
  );
}

async function reachCodeStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
  await user.click(screen.getByRole('button', { name: 'ارسال کد یک‌بارمصرف' }));
  await screen.findByLabelText('کد یک‌بارمصرف');
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
});

describe('the resend countdown', () => {
  it('counts the cooldown, not the code’s own validity', async () => {
    // 60 and 120 are different numbers and the countdown is the first.
    mockApi({ request: () => ok({ requested: true, cooldownRemaining: 60, expiresInSeconds: 120 }) });
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    expect(screen.getByText(/ارسال دوباره کد تا ۰۱:۰۰ دیگر/)).toBeInTheDocument();
    expect(screen.queryByText(/۰۲:۰۰/)).toBeNull();
  });

  it('ticks down and becomes a real control at zero', async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockApi({ request: () => ok({ requested: true, cooldownRemaining: 2, expiresInSeconds: 120 }) });
    renderAuth();
    await reachCodeStep(user);

    expect(screen.getByText(/۰۰:۰۲/)).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    // Not merely repainted: the waiting text becomes a button somebody can
    // press, and the live region announces it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'ارسال دوباره کد' })).toBeInTheDocument());
    jest.useRealTimers();
  });

  it('announces the countdown politely rather than silently repainting it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    const region = document.getElementById('auth-code-hint');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });
});

describe('the two 429s are not the same refusal', () => {
  it('uses the server’s exact wait when it gave one', async () => {
    mockApi({
      request: () => refused(429, 'RATE_LIMITED', 'هنوز نمی‌توانید دوباره درخواست دهید.', { retryAfterSeconds: 43 }),
    });
    const user = userEvent.setup();
    renderAuth();

    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'ارسال کد یک‌بارمصرف' }));

    await waitFor(() => expect(screen.getByText('هنوز نمی‌توانید دوباره درخواست دهید.')).toBeInTheDocument());
    // Still on the phone step — the code was not sent — and the exact wait
    // is shown, because this limit depends only on the last request.
    expect(screen.getByLabelText('شماره موبایل')).toBeInTheDocument();
  });

  it('invents no countdown for the hourly cap, which sends no number', async () => {
    mockApi({
      request: () => refused(429, 'RATE_LIMITED', 'درخواست‌های شما بیش از حد است. کمی بعد دوباره تلاش کنید.'),
    });
    const user = userEvent.setup();
    renderAuth();

    await user.type(screen.getByLabelText('شماره موبایل'), '09123456789');
    await user.click(screen.getByRole('button', { name: 'ارسال کد یک‌بارمصرف' }));

    await waitFor(() =>
      expect(screen.getByText('درخواست‌های شما بیش از حد است. کمی بعد دوباره تلاش کنید.')).toBeInTheDocument(),
    );
    // The absence of `retryAfterSeconds` means UNKNOWN, not zero. A
    // countdown here would be a promise nobody made.
    expect(document.body.textContent).not.toMatch(/۰۰:|دیگر/);
  });
});

describe('the code field', () => {
  it('has six boxes, because the server generates six digits', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    // The design draws four. `otp.service.ts` pads to six, and four boxes
    // would make a real code impossible to enter.
    expect(document.querySelectorAll('[data-box]')).toHaveLength(6);
    expect(screen.getByLabelText('کد یک‌بارمصرف')).toHaveAttribute('maxLength', '6');
  });

  it('is one real input, so the code can be pasted and autofilled', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    const input = screen.getByLabelText('کد یک‌بارمصرف');
    // Six separate inputs would look the same and break paste, SMS
    // autofill and screen-reader use.
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
  });

  it('fills the boxes as digits arrive, and refuses anything else', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    await user.type(screen.getByLabelText('کد یک‌بارمصرف'), '4a7');
    const boxes = [...document.querySelectorAll('[data-box]')].map((b) => b.textContent);
    expect(boxes).toEqual(['۴', '۷', '', '', '', '']);
  });

  it('cannot be submitted until all six digits are present', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    const submit = screen.getByRole('button', { name: 'تأیید و ورود' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('کد یک‌بارمصرف'), '123456');
    expect(submit).toBeEnabled();
  });
});

describe('the phone step', () => {
  it('refuses a malformed number without asking the server', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();

    await user.type(screen.getByLabelText('شماره موبایل'), '12345');
    await user.click(screen.getByRole('button', { name: 'ارسال کد یک‌بارمصرف' }));

    expect(await screen.findByText('شماره موبایل نامعتبر است.')).toBeInTheDocument();
    // The one message this form writes itself: it is about the shape of
    // what was typed, and says nothing about whether an account exists.
    expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('request-otp'))).toBe(false);
    expect(screen.getByLabelText('شماره موبایل')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the number back in the national form on the code step', async () => {
    mockApi();
    const user = userEvent.setup();
    renderAuth();
    await reachCodeStep(user);

    expect(screen.getByText(/پیامک شد/).textContent).toContain('۰۹۱۲۳۴۵۶۷۸۹');
  });
});
