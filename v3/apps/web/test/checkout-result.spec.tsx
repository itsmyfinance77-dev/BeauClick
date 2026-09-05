import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CheckoutResultPage from '@/app/checkout/result/page';
import { ApiRequestError } from '@/lib/api-client';
import { bookingApi } from '@/lib/booking-api';
import { PAYMENT_FAILURE_REASONS, PAYMENT_RESULT_STATUSES } from '@beauclick/payment-contract';

/**
 * The payment result page, against the V3.1 Phase F design.
 *
 * ## The property that governs every case here
 *
 * `status`, `reason`, and `orderId` are **presentation inputs, not payment
 * truth**. They choose a sentence and name an order to ask about; every figure
 * comes from an authenticated re-fetch, and the transaction was decided by a
 * server-to-server verification long before this page rendered.
 *
 * So the adversarial cases below are not about whether a tampered URL can
 * steal money — it cannot reach the payment domain at all — but about whether
 * it can make the page LIE: show success copy over a failure, contradict
 * itself, offer a retry the server will refuse, or echo something the closed
 * public vocabulary exists to keep out of a browser.
 */
let searchParams = new URLSearchParams();
let authStatus: 'loading' | 'authenticated' | 'unauthenticated' = 'authenticated';

const apiStub = {} as never;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/checkout/result',
  useSearchParams: () => searchParams,
}));

jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ api: apiStub, status: authStatus, user: null }),
}));

function renderResult(query: Record<string, string>) {
  searchParams = new URLSearchParams(query);
  return render(<CheckoutResultPage />);
}

/** The result banner, which is the first `role="alert"` on the page. */
function banner(): HTMLElement {
  return screen.getAllByRole('alert')[0];
}

const ORDER = {
  id: 'o1',
  sourceType: 'booking',
  sourceId: 'b1',
  status: 'pending',
  currency: 'IRT',
  subtotalToman: 200000,
  discountTotalToman: 0,
  feeTotalToman: 0,
  totalToman: 200000,
  refundedTotalToman: 0,
  paidAt: null,
  createdAt: '2099-09-01T06:30:00.000Z',
  items: [{ id: 'i1', name: 'میکاپ', quantity: 1, unitPriceToman: 200000, lineTotalToman: 200000 }],
  adjustments: [],
  /*
   * V3.3 `#41a`. The API always serves this, so the fixture always has it --
   * deliberately not made optional in the component, because an order without a
   * schedule is an integrity failure the browser must not paper over.
   *
   * Full-online, which is what every order is today: BeauClick collects the
   * whole service total and nothing is payable at the venue.
   */
  paymentSchedule: {
    collectionMode: 'full_payment_online',
    serviceTotalToman: 200000,
    platformCollectibleNowToman: 200000,
    venueBalanceToman: 0,
  },
};

let getOrder: jest.SpyInstance;
let retryOrderPayment: jest.SpyInstance;
let assign: jest.Mock;

beforeEach(() => {
  authStatus = 'authenticated';
  getOrder = jest.spyOn(bookingApi, 'getOrder').mockResolvedValue({ data: ORDER, meta: null, error: null } as never);
  retryOrderPayment = jest.spyOn(bookingApi, 'retryOrderPayment');

  assign = jest.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign },
    writable: true,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the six result statuses', () => {
  it.each([
    ['succeeded', 'پرداخت انجام شد'],
    ['replayed', 'این پرداخت قبلاً ثبت شده بود'],
    ['failed', 'پرداخت انجام نشد'],
    ['refunded', 'پرداخت برگشت داده شد'],
    ['duplicate_refunded', 'رزرو شما تأیید شد'],
    ['unresolved', 'وضعیت پرداخت هنوز مشخص نیست'],
  ])('%s renders its own heading', async (status, heading) => {
    renderResult({ status, orderId: 'o1' });
    expect(await screen.findByRole('heading', { level: 1, name: new RegExp(heading) })).toBeInTheDocument();
  });

  it('covers every status the contract declares — none is unhandled', () => {
    // If a status is added server-side and nobody adds copy for it, this fails
    // rather than the page silently falling back to "پرداخت انجام نشد" in
    // production.
    for (const status of PAYMENT_RESULT_STATUSES) {
      renderResult({ status, orderId: 'o1' });
      const heading = screen.getAllByRole('heading', { level: 1 }).at(-1);
      expect(heading?.textContent).toBeTruthy();
      if (status !== 'failed') {
        expect(heading?.textContent).not.toContain('پرداخت انجام نشد');
      }
    }
  });
});

describe('the corrected copy — the contradiction the design found', () => {
  it('promises NOTHING automatic on an unresolved verification', async () => {
    // The previous copy said any amount deducted would be "به‌صورت خودکار
    // تعیین تکلیف می‌شود". There is no reconciliation sweep; §8 of the Phase F
    // report records that one was deliberately not built. The sentence
    // described a mechanism that does not exist, about a customer's money.
    renderResult({ status: 'unresolved', orderId: 'o1', reason: 'unresolved' });
    const text = banner().textContent ?? '';

    expect(text).not.toContain('تعیین تکلیف');
    expect(text).not.toContain('خودکار');
    // And it must not claim in the other direction either.
    expect(text).not.toContain('کسر نشده');
  });

  it('says the three things the design requires and nothing more', async () => {
    renderResult({ status: 'unresolved', orderId: 'o1' });
    const text = banner().textContent ?? '';

    expect(text).toContain('معلوم نیست'); // the result is unknown
    expect(text).toContain('دوباره پرداخت نکنید'); // do not retry
    expect(text).toContain('رزروهای من'); // go and look
    expect(text).toContain('پشتیبانی'); // and who to contact if they disagree
  });

  it('promises no automatic refund on a gateway error', async () => {
    // `gateway_error` is a DEFINITIVE failure: the gateway said the
    // transaction did not succeed, so nothing was captured and there is
    // nothing to refund. The old copy promised one anyway.
    renderResult({ status: 'failed', orderId: 'o1', reason: 'gateway_error' });
    const text = banner().textContent ?? '';

    expect(text).not.toContain('بازگردانده می‌شود');
    expect(text).toContain('ثبت نشد');
    expect(text).toContain('پشتیبانی');
  });

  it('renders a refunded outcome in the WARNING tone, not the error tone', async () => {
    // The customer did nothing wrong: their slot expired and the money came
    // back. The error colour presents a correction the platform made FOR them
    // as a problem they caused.
    //
    // Asserted through the SHAPE marker rather than the colour, and that is a
    // limitation worth naming: jsdom's CSS parser drops declarations whose
    // value is a `var()`, so `background: var(--bc-color-warning-soft)` is not
    // in the style attribute it reports and no assertion on the token can be
    // made here. The glyph is the honest observable — and it is also the half
    // that matters most, because shape rather than colour is what carries the
    // distinction for a reader who cannot tell amber from red. The token pair
    // itself is measured against WCAG AA in
    // `packages/design-tokens/src/contrast.spec.ts`.
    renderResult({ status: 'refunded', orderId: 'o1' });
    const heading = await screen.findByRole('heading', { level: 1 });

    expect(heading.textContent).toContain('⚠');
    expect(heading.textContent).not.toContain('✕');
  });

  it('marks each outcome with a shape, not only a colour', async () => {
    // The accessibility requirement from §3 of the design: a reader who cannot
    // distinguish the tones still gets the verdict.
    for (const [status, glyph] of [
      ['succeeded', '✓'],
      ['replayed', '✓'],
      ['duplicate_refunded', '✓'],
      ['refunded', '⚠'],
      ['unresolved', '⚠'],
      ['failed', '✕'],
    ] as const) {
      renderResult({ status, orderId: 'o1' });
      expect(screen.getAllByRole('heading', { level: 1 }).at(-1)?.textContent).toContain(glyph);
    }
  });

  it('hides the glyph from assistive tech, because the heading already says it', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.querySelector('[aria-hidden="true"]')?.textContent).toBe('✓');
  });
});

describe('the eight public failure reasons', () => {
  it.each(PAYMENT_FAILURE_REASONS.map((r) => [r]))('%s renders its own sentence', async (reason) => {
    renderResult({ status: 'failed', orderId: 'o1', reason });
    const text = banner().textContent ?? '';
    expect(text.length).toBeGreaterThan(20);
    // Never the raw code, in any of them.
    expect(text).not.toContain(reason);
  });

  it('gives cancel and decline DIFFERENT sentences — the regression QA-21 names', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'cancelled_by_user' });
    const cancelled = banner().textContent;

    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });
    const declined = screen.getAllByRole('alert').at(-1)?.textContent;

    expect(cancelled).not.toEqual(declined);
    expect(cancelled).toContain('لغو کردید');
    expect(declined).toContain('بانک این تراکنش را تأیید نکرد');
  });

  it('produces a distinct sentence for every reason — no two collapse', () => {
    const sentences = new Set<string>();
    for (const reason of PAYMENT_FAILURE_REASONS) {
      renderResult({ status: 'failed', orderId: 'o1', reason });
      sentences.add(screen.getAllByRole('alert').at(-1)?.textContent ?? '');
    }
    expect(sentences.size).toBe(PAYMENT_FAILURE_REASONS.length);
  });
});

/**
 * The URL security boundary. A query string is user-editable, and the only
 * thing it may change is which sentence appears.
 */
describe('a tampered URL', () => {
  it('cannot make a successful payment render failure copy', async () => {
    // The server attaches a reason only to `failed` and `unresolved`. A
    // recognised reason appended to a success must be IGNORED, not rendered —
    // otherwise the page contradicts itself.
    renderResult({ status: 'succeeded', orderId: 'o1', reason: 'declined' });

    expect(await screen.findByRole('heading', { level: 1, name: /پرداخت انجام شد/ })).toBeInTheDocument();
    const text = banner().textContent ?? '';
    expect(text).toContain('رزرو شما تأیید شد');
    expect(text).not.toContain('بانک این تراکنش را تأیید نکرد');
  });

  it.each(['replayed', 'refunded', 'duplicate_refunded'])(
    'ignores a reason on %s, where the server never attaches one',
    async (status) => {
      renderResult({ status, orderId: 'o1', reason: 'amount_mismatch' });
      expect(banner().textContent).not.toContain('رویداد امنیتی');
    },
  );

  it('falls back safely for an unknown status', async () => {
    renderResult({ status: 'totally-made-up', orderId: 'o1' });
    expect(await screen.findByRole('heading', { level: 1, name: /پرداخت انجام نشد/ })).toBeInTheDocument();
  });

  it('falls back safely for an unknown reason, and never echoes it', async () => {
    // Forward compatibility in the safe direction, and the redaction boundary:
    // a value this bundle does not know must not be rendered.
    renderResult({ status: 'failed', orderId: 'o1', reason: 'NOK merchant 1234-5678 rejected authority A000' });
    const text = banner().textContent ?? '';

    expect(text).toContain('مبلغی از حساب شما کسر نشده است');
    expect(text).not.toContain('merchant');
    expect(text).not.toContain('1234-5678');
  });

  it('never renders a provider or internal code, whatever the URL carries', async () => {
    for (const hostile of ['-51', 'intent_expired', 'verification_timeout', '<script>alert(1)</script>']) {
      renderResult({ status: 'failed', orderId: 'o1', reason: hostile });
      const text = screen.getAllByRole('alert').at(-1)?.textContent ?? '';
      expect(text).not.toContain(hostile);
    }
  });

  it('still reads the receipt from the authenticated API, never from the URL', async () => {
    // The figures come from the server regardless of what the status claims.
    renderResult({ status: 'succeeded', orderId: 'o1', totalToman: '999999999' } as Record<string, string>);
    await waitFor(() => expect(getOrder).toHaveBeenCalledWith(apiStub, 'o1'));

    // The server's figure, not the URL's. It appears twice -- once as the line
    // total and once as the order total -- which is itself the point: both
    // came from the same authenticated response.
    expect((await screen.findAllByText(/۲۰۰٬۰۰۰/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/۹۹۹٬۹۹۹٬۹۹۹/)).toBeNull();
  });
});

describe('the states that used to render nothing', () => {
  it('explains a missing orderId instead of silently dropping the receipt', async () => {
    renderResult({ status: 'failed' });
    expect(await screen.findByText(/شناسهٔ سفارش در این لینک موجود نیست/)).toBeInTheDocument();
  });

  it('makes NO order request when there is no orderId', async () => {
    renderResult({ status: 'failed' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument());
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('offers login to an unauthenticated visitor, returning to this exact URL', async () => {
    authStatus = 'unauthenticated';
    renderResult({ status: 'succeeded', orderId: 'o1' });

    const login = await screen.findByRole('link', { name: 'ورود' });
    const href = login.getAttribute('href') ?? '';
    expect(href.startsWith('/auth?next=')).toBe(true);
    expect(decodeURIComponent(href)).toContain('/checkout/result?status=succeeded&orderId=o1');
  });

  it('makes NO order request while unauthenticated', async () => {
    // A page that fired an authenticated read without a session would produce
    // a 401 on every visit and teach nobody anything.
    authStatus = 'unauthenticated';
    renderResult({ status: 'succeeded', orderId: 'o1' });
    await screen.findByRole('link', { name: 'ورود' });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('still shows the result banner without a session', async () => {
    // The outcome is not private; the receipt is.
    authStatus = 'unauthenticated';
    renderResult({ status: 'succeeded', orderId: 'o1' });
    expect(await screen.findByRole('heading', { level: 1, name: /پرداخت انجام شد/ })).toBeInTheDocument();
  });
});

describe('a failed receipt fetch', () => {
  it('offers a retry and actually refetches on it', async () => {
    getOrder.mockRejectedValueOnce(new Error('ارتباط با سرور برقرار نشد.'));
    renderResult({ status: 'succeeded', orderId: 'o1' });

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(getOrder).toHaveBeenCalledTimes(1);

    await userEvent.click(retry);

    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(2));
    // And the retry SUCCEEDS, so the receipt appears rather than the page
    // simply re-rendering the same error.
    expect(await screen.findByText('رسید')).toBeInTheDocument();
  });
});

describe('heading focus', () => {
  it('moves focus to the heading once, so a returning customer lands on the outcome', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    const heading = await screen.findByRole('heading', { level: 1 });

    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('does not steal focus back after the customer moves it', async () => {
    // The failure mode of a focus effect with the wrong dependencies: it fires
    // on every render and yanks the cursor back mid-interaction, which is
    // worse than not moving it at all.
    getOrder.mockRejectedValueOnce(new Error('failed'));
    renderResult({ status: 'succeeded', orderId: 'o1' });

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    retry.focus();
    expect(retry).toHaveFocus();

    await userEvent.click(retry);
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
  });
});

describe('the retry action', () => {
  const RETRYABLE = ['cancelled_by_user', 'declined', 'not_completed', 'gateway_error'];
  const NOT_RETRYABLE = ['expired', 'unknown_reference', 'amount_mismatch', 'unresolved'];

  function retryButton(): HTMLElement | null {
    return screen.queryAllByRole('button', { name: 'تلاش دوباره' })[0] ?? null;
  }

  it.each(RETRYABLE.map((r) => [r]))('is offered for %s', async (reason) => {
    renderResult({ status: 'failed', orderId: 'o1', reason });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).not.toBeNull();
  });

  it.each(NOT_RETRYABLE.map((r) => [r]))('is NOT offered for %s', async (reason) => {
    // Each is a different harm: `unresolved` risks a double charge,
    // `amount_mismatch` is an open security question, `unknown_reference`
    // cannot be reasoned about, and `expired` is a re-booking question this
    // platform has no safe path for.
    renderResult({ status: 'failed', orderId: 'o1', reason });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).toBeNull();
  });

  it('is not offered on an unresolved STATUS either', async () => {
    renderResult({ status: 'unresolved', orderId: 'o1', reason: 'unresolved' });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).toBeNull();
  });

  it.each(['succeeded', 'replayed', 'refunded', 'duplicate_refunded'])('is not offered on %s', async (status) => {
    renderResult({ status, orderId: 'o1', reason: 'declined' });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).toBeNull();
  });

  it('is not offered without a session, because retry needs one', async () => {
    authStatus = 'unauthenticated';
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).toBeNull();
  });

  it('is not offered without an orderId, because there is nothing to name', async () => {
    renderResult({ status: 'failed', reason: 'declined' });
    await screen.findByRole('heading', { level: 1 });
    expect(retryButton()).toBeNull();
  });

  it('navigates only to the URL the SERVER returned', async () => {
    retryOrderPayment.mockResolvedValue({
      data: { redirectUrl: 'https://gateway.example/pay/abc' },
      meta: null,
      error: null,
    } as never);
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    await userEvent.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://gateway.example/pay/abc'));
    expect(retryOrderPayment).toHaveBeenCalledWith(apiStub, 'o1');
    // The page never builds a gateway URL and never reads one from its own
    // query string.
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('cannot be submitted twice by a double click', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    retryOrderPayment.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    const button = await screen.findByRole('button', { name: 'تلاش دوباره' });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    expect(retryOrderPayment).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    resolve({ data: { redirectUrl: 'https://gateway.example/pay/abc' }, meta: null, error: null });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  });

  it('stays disabled after a successful initiation, because the browser is leaving', async () => {
    retryOrderPayment.mockResolvedValue({
      data: { redirectUrl: 'https://gateway.example/pay/abc' },
      meta: null,
      error: null,
    } as never);
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    const button = await screen.findByRole('button', { name: 'تلاش دوباره' });
    await userEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalled());

    // Re-enabling it would offer a second payment during unload.
    expect(button).toBeDisabled();
  });

  it.each([
    ['verification_pending', /در حال بررسی/],
    ['already_paid', /قبلاً پرداخت شده/],
    ['expired', /مهلت پرداخت/],
    ['order_not_payable', /دیگر قابل پرداخت نیست/],
    ['not_retryable', /پشتیبانی/],
    ['no_payment_started', /آغاز نشده/],
  ])('renders an actionable message when the server refuses with %s', async (refusal, expected) => {
    retryOrderPayment.mockRejectedValue(
      new ApiRequestError('PAYMENT_RETRY_NOT_AVAILABLE', 'امکان تلاش دوباره وجود ندارد.', 409, { reason: refusal }),
    );
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    await userEvent.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => expected.test(a.textContent ?? ''))).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('re-enables the button after a refusal, so the customer is not stuck', async () => {
    retryOrderPayment.mockRejectedValue(
      new ApiRequestError('PAYMENT_RETRY_NOT_AVAILABLE', 'no', 409, { reason: 'verification_pending' }),
    );
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    const button = await screen.findByRole('button', { name: 'تلاش دوباره' });
    await userEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('falls back to the server message for an unrecognised refusal', async () => {
    retryOrderPayment.mockRejectedValue(
      new ApiRequestError('PAYMENT_RETRY_NOT_AVAILABLE', 'پیام سرور', 409, { reason: 'something_new' }),
    );
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    await userEvent.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => (a.textContent ?? '').includes('پیام سرور'))).toBe(true);
  });

  it('reports a network failure without navigating anywhere', async () => {
    retryOrderPayment.mockRejectedValue(new ApiRequestError('NETWORK_ERROR', 'ارتباط با سرور برقرار نشد.', 0));
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    await userEvent.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => (a.textContent ?? '').includes('ارتباط با سرور'))).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not navigate when the server returns no URL', async () => {
    retryOrderPayment.mockResolvedValue({ data: {}, meta: null, error: null } as never);
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });

    await userEvent.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(1));
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the two navigation links alongside it', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });
    expect(await screen.findByRole('link', { name: 'رزروهای من' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'بازگشت به فهرست متخصص‌ها' })).toBeInTheDocument();
  });
});

describe('preserved behaviour', () => {
  it('keeps the 44px touch baseline on both navigation links', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    for (const name of ['رزروهای من', 'بازگشت به فهرست متخصص‌ها']) {
      const link = await screen.findByRole('link', { name });
      expect(link.getAttribute('style')).toContain('min-height: 44px');
    }
  });

  it('announces loading politely rather than as an alert', async () => {
    getOrder.mockImplementation(() => new Promise(() => undefined));
    renderResult({ status: 'succeeded', orderId: 'o1' });
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('renders the receipt from server figures', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    const receipt = await screen.findByText('رسید');
    expect(receipt).toBeInTheDocument();
    expect(within(receipt.closest('div') as HTMLElement).getByText('میکاپ')).toBeInTheDocument();
  });
});

/**
 * The collection schedule on the receipt — V3.3 `#41a`, ADR-043 §8.
 *
 * Two properties matter and they pull against each other: the split must be
 * visible when it says something, and it must not change a full-online receipt,
 * which is every receipt today.
 */
describe('the payment schedule on the receipt', () => {
  it('leaves a full-online receipt showing exactly the total it showed before #41a', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    const receipt = (await screen.findByText('رسید')).closest('div') as HTMLElement;

    // `مبلغ کل` is untouched: the schedule is additive, never a replacement.
    expect(within(receipt).getByText('مبلغ کل')).toBeInTheDocument();
    expect(within(receipt).getByText('۲۰۰٬۰۰۰ تومان')).toBeInTheDocument();

    // ...and the split rows are absent, because "collect 200,000 / pay 0 at the
    // venue" is noise on a receipt where nothing is payable at the venue.
    expect(within(receipt).queryByText('پرداخت‌شده به بیوکلیک')).not.toBeInTheDocument();
    expect(within(receipt).queryByText('قابل پرداخت در محل')).not.toBeInTheDocument();
  });

  it('shows both server-owned amounts when a venue balance exists, and computes neither', async () => {
    /*
     * No collection mode can produce this today -- `V33-DEC-011` is open and
     * `#41a` writes `full_payment_online` for every order. The case exists so
     * the projection is proved to render the SERVER's numbers before a mode can
     * produce them, rather than being discovered wrong by #82.
     *
     * The amounts are deliberately NOT a clean split of the total: if the
     * component ever subtracts instead of reading, these values are what
     * catches it.
     */
    /*
     * `totalToman` is deliberately NOT the service total here.
     *
     * A mutation probe found the first version of this case vacuous: with
     * `totalToman === serviceTotalToman`, a component that computed
     * `totalToman - collectible` produced exactly the stored venue balance and
     * the test could not tell the two apart. Making them differ is what turns
     * this into a real assertion that the component READS the schedule.
     */
    getOrder.mockResolvedValue({
      data: {
        ...ORDER,
        // A THIRD distinct value: different from the service total and from the
        // collectible, so a component that derives from it produces 35,000 --
        // wrong, and visibly so -- and so no rendered amount collides with
        // another and makes the query ambiguous.
        totalToman: 95000,
        paymentSchedule: {
          collectionMode: 'deposit_online_balance_at_venue',
          serviceTotalToman: 200000,
          platformCollectibleNowToman: 60000,
          venueBalanceToman: 140000,
        },
      },
      meta: null,
      error: null,
    });

    renderResult({ status: 'succeeded', orderId: 'o1' });
    const receipt = (await screen.findByText('رسید')).closest('div') as HTMLElement;

    expect(within(receipt).getByText('پرداخت‌شده به بیوکلیک')).toBeInTheDocument();
    expect(within(receipt).getByText('۶۰٬۰۰۰ تومان')).toBeInTheDocument();
    expect(within(receipt).getByText('قابل پرداخت در محل')).toBeInTheDocument();
    expect(within(receipt).getByText('۱۴۰٬۰۰۰ تومان')).toBeInTheDocument();
  });
});
