import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REFERRAL_CLAIM_REFUSED_CODE, buildReferralInviteUrl, buildReferralShareText } from '@beauclick/referral-contract';
import ReferralPage from '@/app/referral/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/referral',
}));

/**
 * `/referral`, against `39_REFERRAL.md`: the customer's own code to share and a
 * box to claim a friend's. Two routes exist and neither reads a status, so
 * nothing here may show, count or imply one.
 */

const CODE = 'K7MQ2XW9RT';
const VIEW = {
  code: CODE,
  inviteUrl: buildReferralInviteUrl('https://beauclick.example', CODE),
  shareText: buildReferralShareText(CODE),
  shareChannels: ['copy_code', 'copy_link', 'native_share'],
};
const FRIEND = 'ABCDEFGHJK'; // ten characters, all in the alphabet

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

interface Routes {
  code?: () => Promise<unknown>;
  claim?: () => Promise<unknown>;
}

function mockApi(routes: Routes = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: [] });
    if (url.includes('/v1/me/referral/code')) return routes.code ? routes.code() : ok(VIEW);
    if (url.includes('/v1/me/referral/claim')) {
      return routes.claim ? routes.claim() : ok({ attributedAt: '2026-09-21T10:00:00.000Z', expiresAt: '2026-12-20T10:00:00.000Z' });
    }
    return ok([]);
  });
}

function calls(fragment: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
}

function renderPage() {
  return render(
    <AuthProvider>
      <ReferralPage />
    </AuthProvider>,
  );
}

function setNavigator(name: 'share' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true, writable: true });
}

const claimInput = () => screen.getByLabelText('کد دعوت دوست') as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: 'ثبت کد' });

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
  setNavigator('share', undefined);
});

describe('the share panel', () => {
  it('shows the code and the invite link, each isolated left-to-right inside the RTL page', async () => {
    mockApi();
    renderPage();
    const code = await screen.findByTestId('referral-code');
    expect(code).toHaveTextContent(CODE);
    expect(screen.getByTestId('referral-link')).toHaveTextContent(VIEW.inviteUrl);
    expect(code.className).toContain('value');
  });

  it('gives the two copy controls distinct names and announces each copy politely', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    const writeText = jest.fn().mockResolvedValue(undefined);
    setNavigator('clipboard', { writeText });

    await user.click(screen.getByRole('button', { name: 'کپیِ کد' }));
    expect(writeText).toHaveBeenLastCalledWith(CODE);
    await waitFor(() => expect(screen.getByText('کد کپی شد.')).toBeInTheDocument());
    expect(screen.getByText('کد کپی شد.')).toHaveAttribute('aria-live', 'polite');

    await user.click(screen.getByRole('button', { name: 'کپیِ پیوند' }));
    expect(writeText).toHaveBeenLastCalledWith(VIEW.inviteUrl);
    await waitFor(() => expect(screen.getByText('پیوند کپی شد.')).toBeInTheDocument());
  });

  it('says so when the clipboard refuses, rather than claiming a copy', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    setNavigator('clipboard', { writeText: jest.fn().mockRejectedValue(new Error('denied')) });
    await user.click(screen.getByRole('button', { name: 'کپیِ کد' }));
    expect(await screen.findByText(/کپی انجام نشد/)).toBeInTheDocument();
    expect(screen.queryByText('کد کپی شد.')).toBeNull();
  });

  it('offers native share only where the browser has it — the copy controls never depend on it', async () => {
    mockApi();
    renderPage();
    await screen.findByTestId('referral-code');
    expect(screen.queryByRole('button', { name: 'اشتراک‌گذاری' })).toBeNull();
    expect(screen.getByRole('button', { name: 'کپیِ کد' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'کپیِ پیوند' })).toBeInTheDocument();
  });

  it('hands the server’s own share payload to navigator.share', async () => {
    setNavigator('share', jest.fn().mockResolvedValue(undefined));
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'اشتراک‌گذاری' }));
    expect(navigator.share).toHaveBeenCalledWith({ title: 'دعوت به بیوکلیک', text: VIEW.shareText, url: VIEW.inviteUrl });
  });

  it('treats a closed share sheet as the customer’s choice: no error, no “sent” claim', async () => {
    setNavigator('share', jest.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'اشتراک‌گذاری' }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(screen.queryByText(/انجام نشد/)).toBeNull();
    expect(screen.queryByText(/ارسال شد|فرستاده شد/)).toBeNull();
  });

  it('always states, permanently, that there is no reward — and never a figure', async () => {
    mockApi();
    renderPage();
    await screen.findByTestId('referral-code');
    expect(screen.getByText(/امتیاز یا پاداشی ندارد/)).toBeInTheDocument();
    // Only a completed booking qualifies an invite; the copy says so and never says payment or registration.
    expect(screen.getByText(/نخستین رزروِ انجام‌شده/)).toBeInTheDocument();
  });

  it('offers a retry when the code fails to load — and the claim box is still there', async () => {
    let attempt = 0;
    mockApi({ code: () => (++attempt === 1 ? fail(500, 'INTERNAL', 'خطای سرور') : ok(VIEW)) });
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    expect(claimInput()).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByTestId('referral-code')).toHaveTextContent(CODE);
  });
});

describe('the claim box', () => {
  it('names its field with a real label and describes it, and is offered unconditionally', async () => {
    mockApi();
    renderPage();
    await screen.findByTestId('referral-code');
    const input = claimInput();
    expect(input).toHaveAttribute('dir', 'ltr');
    const hint = document.getElementById(input.getAttribute('aria-describedby') as string) as HTMLElement;
    expect(hint).toHaveTextContent('ده نویسه');
  });

  it('cannot be submitted with a code of the wrong shape — and spends no attempt finding out', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    expect(submit()).toBeDisabled();
    await user.type(claimInput(), 'abcdefghjk'); // lowercase: not a referral code
    expect(submit()).toBeDisabled();
    await user.clear(claimInput());
    await user.type(claimInput(), 'ABC');
    expect(submit()).toBeDisabled();
    await user.clear(claimInput());
    await user.type(claimInput(), 'ABCDEFGHJ0'); // '0' is not in the alphabet
    expect(submit()).toBeDisabled();
    expect(calls('/v1/me/referral/claim')).toHaveLength(0);
  });

  it('sends the code and nothing else, trimmed', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), `  ${FRIEND} `);
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(calls('/v1/me/referral/claim')).toHaveLength(1));
    const [, init] = calls('/v1/me/referral/claim')[0];
    expect(JSON.parse(init.body)).toEqual({ code: FRIEND });
  });

  it('shows the customer’s own two facts from the response, once, as a status', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), FRIEND);
    await user.click(submit());

    const panel = (await screen.findByText('کد دعوت ثبت شد')).closest('[role=status]') as HTMLElement;
    expect(within(panel).getByText('زمان ثبت')).toBeInTheDocument();
    expect(within(panel).getByText('مهلت تکمیل نخستین رزرو')).toBeInTheDocument();
    expect(panel).toHaveTextContent('۹۰ روز');
    expect(panel).toHaveTextContent('فقط همین یک بار');
    // The one-shot form goes away; nothing invites a second attempt.
    expect(screen.queryByLabelText('کد دعوت دوست')).toBeNull();
  });

  it('answers a refusal with the server’s one sentence and no reason', async () => {
    mockApi({ claim: () => fail(409, REFERRAL_CLAIM_REFUSED_CODE, 'این کد دعوت برای حساب شما قابل استفاده نیست.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), FRIEND);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('این کد دعوت برای حساب شما قابل استفاده نیست.');
    expect(alert).toHaveTextContent('این کد قابل استفاده نیست');
    // It can be tried again with another code.
    expect(claimInput()).toBeInTheDocument();
  });

  it('shows the published hourly limit on a throttle — no countdown — and disables submitting', async () => {
    mockApi({ claim: () => fail(429, 'REFERRAL_CLAIM_THROTTLED', 'تعداد تلاش‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), FRIEND);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('حداکثر ۱۰ تلاش در هر ساعت');
    expect(alert.textContent).not.toMatch(/دقیقه|ثانیه|باقی/);
    expect(submit()).toBeDisabled();
  });

  it('keeps a malformed request (400) apart from a refusal', async () => {
    mockApi({ claim: () => fail(400, 'VALIDATION_ERROR', 'درخواست نامعتبر است.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), FRIEND);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('درخواست نامعتبر است');
    expect(alert).not.toHaveTextContent('قابل استفاده نیست');
  });

  it('reports any other failure as a plain failure, not as a refusal', async () => {
    mockApi({ claim: () => fail(500, 'INTERNAL', 'خطای سرور') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('referral-code');
    await user.type(claimInput(), FRIEND);
    await user.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ثبت کد انجام نشد');
    expect(alert).not.toHaveTextContent('قابل استفاده نیست');
  });
});
