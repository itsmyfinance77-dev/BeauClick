import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SandboxGatewayPage from '@/app/sandbox-gateway/page';

const REFERENCE = 'SBX-1B548A54356128F217B3E40B';
const CALLBACK = 'http://localhost:3099/api/v1/payments/callback/sandbox';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ reference: REFERENCE, callback: CALLBACK }),
}));

/**
 * `R31-20` regression — the sandbox gateway's return leg.
 *
 * The gateway page's whole job is: record a decision on the gateway side,
 * then return the browser to the merchant's callback. The second half was
 * broken and no test could see it, because every existing check on this page
 * asserted the return-URL ALLOWLIST (`sandbox-callback.spec.ts`) — which
 * answers "is this address safe to navigate to", never "do we navigate".
 *
 * `POST /v1/sandbox-gateway/:reference/decide` is an ordinary JSON route, so
 * its answer arrives inside the standard `{ data, meta, error }` envelope.
 * The page read `body.accepted` off the ENVELOPE, where it is permanently
 * `undefined`, so the "was this decision refused?" guard fired on EVERY
 * response — including a successful one. A customer who paid saw the false
 * error «این تراکنش پیش‌تر نهایی شده است» and was never returned to the
 * callback, so the payment was never verified and the order stayed pending
 * forever. Same browser-only shape as `R31-17`, different root cause, and
 * invisible to the API suites for the same reason: they call the callback
 * directly and never drive this page.
 *
 * These pin both halves — the success path must navigate, and each genuine
 * refusal must still be refused with its own message.
 */
describe('sandbox gateway decision → return leg (R31-20)', () => {
  const originalLocation = window.location;
  let assigned: string;

  beforeEach(() => {
    assigned = '';
    // `window.location.href = …` is the navigation under test; jsdom cannot
    // perform it, so the property is replaced with a recorder rather than
    // the assertion being weakened to "did not throw".
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        origin: 'http://localhost:3100',
        set href(value: string) {
          assigned = value;
        },
        get href() {
          return assigned;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    jest.restoreAllMocks();
  });

  function respondWith(data: unknown, status = 201) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status < 400,
      status,
      // The ENVELOPE, exactly as the interceptor emits it. A test that
      // returned the bare `{ accepted: true }` would pass against the bug.
      json: async () => ({ data, meta: null, error: null }),
    }) as unknown as typeof fetch;
  }

  it('returns the browser to the callback, carrying only the reference, when the decision is accepted', async () => {
    respondWith({ accepted: true });
    render(<SandboxGatewayPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'پرداخت موفق' }));

    await waitFor(() => expect(assigned).not.toBe(''));
    const url = new URL(assigned);
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(url.searchParams.get('reference')).toBe(REFERENCE);
    // The outcome is deliberately NOT carried: the API asks the gateway
    // server-to-server. A page that leaked it here would make the redirect
    // itself evidence of payment.
    expect(url.searchParams.get('decision')).toBeNull();
    expect(url.searchParams.get('outcome')).toBeNull();
    expect(url.searchParams.get('status')).toBeNull();
    expect(screen.queryByText(/این تراکنش پیش‌تر نهایی شده است/)).not.toBeInTheDocument();
  });

  it('does NOT navigate, and says the transaction is already settled, when the decision is refused', async () => {
    // `decide()` is a compare-and-swap on `outcome = 'pending'`, so a second
    // decision answers 200/201 with `accepted: false`. Checking only the HTTP
    // status here would follow a refused decision with a confident redirect.
    respondWith({ accepted: false });
    render(<SandboxGatewayPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'پرداخت موفق' }));

    expect(await screen.findByText(/این تراکنش پیش‌تر نهایی شده است/)).toBeInTheDocument();
    expect(assigned).toBe('');
  });

  it('does NOT navigate, and names the real reason, when the sandbox is disabled in this environment', async () => {
    respondWith({ accepted: false, reason: 'sandbox_gateway_disabled' });
    render(<SandboxGatewayPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'پرداخت موفق' }));

    expect(await screen.findByText(/درگاه آزمایشی در این محیط غیرفعال است/)).toBeInTheDocument();
    expect(assigned).toBe('');
  });

  it('does NOT navigate when the gateway itself errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ data: null, meta: null, error: { code: 'INTERNAL_ERROR', message: 'خطا' } }),
    }) as unknown as typeof fetch;
    render(<SandboxGatewayPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'پرداخت موفق' }));

    expect(await screen.findByText(/درگاه آزمایشی پاسخ نداد/)).toBeInTheDocument();
    expect(assigned).toBe('');
  });

  it('carries the same return leg for the failure and cancel decisions', async () => {
    for (const label of ['پرداخت ناموفق (رد شده توسط بانک)', 'انصراف از پرداخت']) {
      assigned = '';
      respondWith({ accepted: true });
      const view = render(<SandboxGatewayPage />);

      await userEvent.click(await screen.findByRole('button', { name: label }));

      await waitFor(() => expect(assigned).not.toBe(''));
      expect(new URL(assigned).searchParams.get('reference')).toBe(REFERENCE);
      view.unmount();
    }
  });
});
