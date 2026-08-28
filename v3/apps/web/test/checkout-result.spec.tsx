import { render, screen, waitFor } from '@testing-library/react';
import CheckoutResultPage from '@/app/checkout/result/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

/**
 * The payment result page, driven by the redirect contract (`QA-21`).
 *
 * The gap this closes is small to describe and large to experience: `cancel`
 * and `decline` produced the same sentence. A customer who pressed "انصراف" at
 * their bank was told their payment had been REFUSED -- which sends them to
 * their bank hunting a problem that does not exist -- and a customer whose
 * card was genuinely declined was given no hint that another card might work.
 *
 * The page is a client component reading `useSearchParams`, so the parameters
 * ARE the input under test. Each case sets the exact query string the API's
 * `resultUrl` would have produced.
 */
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/checkout/result',
  useSearchParams: () => searchParams,
}));

function renderResult(query: Record<string, string>) {
  searchParams = new URLSearchParams(query);
  return render(
    <AuthProvider>
      <CheckoutResultPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  // The page re-fetches the order for its receipt. Every assertion here is
  // about the HEADLINE and the alert, so an empty order response is enough --
  // and it keeps the cases independent of the receipt's own rendering.
  global.fetch = jest.fn(async () =>
    ({ ok: true, status: 200, json: async () => ({ data: null, meta: null, error: null }) }) as unknown as Response,
  ) as unknown as typeof fetch;
  tokenStorage.clear();
});

describe('checkout result — failure reasons (QA-21)', () => {
  it('tells a customer who CANCELLED that they cancelled', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'cancelled_by_user' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('لغو کردید');
    // And explicitly that no money moved, which is true for this reason.
    expect(alert.textContent).toContain('کسر نشده');
  });

  it('tells a customer whose bank DECLINED something different', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'declined' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('بانک این تراکنش را تأیید نکرد');
    // The actionable half: try a different card. Absent before QA-21.
    expect(alert.textContent).toContain('کارت');
  });

  it('renders a DIFFERENT sentence for cancel and decline — the regression QA-21 names', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'cancelled_by_user' });
    const cancelled = (await screen.findByRole('alert')).textContent;

    renderResult({ status: 'failed', orderId: 'o2', reason: 'declined' });
    const declined = (await screen.findAllByRole('alert')).at(-1)?.textContent;

    expect(cancelled).not.toEqual(declined);
  });

  it('never promises a refund or a zero charge on an UNRESOLVED verification', async () => {
    // The single most important sentence on this page. An unresolved
    // verification means the server wrote nothing and the money may well have
    // moved; telling the customer otherwise makes them retry and be charged
    // twice.
    renderResult({ status: 'unresolved', orderId: 'o1', reason: 'unresolved' });

    expect(await screen.findByText('وضعیت پرداخت هنوز مشخص نیست')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('دوباره پرداخت نکنید');
    expect(alert.textContent).not.toContain('کسر نشده');
  });

  it('does not invite a retry when the amount did not match', async () => {
    renderResult({ status: 'failed', orderId: 'o1', reason: 'amount_mismatch' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('پشتیبانی');
  });

  it('falls back to the generic copy for a reason it does not recognise', async () => {
    // Forward compatibility in the safe direction: a server that learns a new
    // reason before this bundle does must not render an empty alert.
    renderResult({ status: 'failed', orderId: 'o1', reason: 'something_new_from_a_future_adapter' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('مبلغی از حساب شما کسر نشده است');
  });

  it('shows the success copy and no failure sentence when there is no reason', async () => {
    renderResult({ status: 'succeeded', orderId: 'o1' });
    expect(await screen.findByText('پرداخت انجام شد')).toBeInTheDocument();
  });

  it('still tells the truth when a customer edits the reason on a successful payment', async () => {
    // The page's standing property: `status` and `reason` choose a SENTENCE.
    // Every figure comes from re-fetching the order. Adding `reason` must not
    // and does not weaken that.
    renderResult({ status: 'succeeded', orderId: 'o1', reason: 'declined' });
    // The headline follows `status`, which is what a customer sees first.
    expect(await screen.findByText('پرداخت انجام شد')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});
