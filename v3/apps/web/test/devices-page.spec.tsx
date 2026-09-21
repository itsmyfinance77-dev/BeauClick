import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DevicesPage from '@/app/account/devices/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/account/devices',
}));

/**
 * `/account/devices`, against `30_DEVICE_SESSIONS.md`: see the devices signed in
 * to the account and sign the others out — never the one in your hand.
 *
 * The case worth the most is the API one: `POST /logout-all-devices` signs out
 * EVERY session including the current one, so "sign out my other devices" must
 * be built from single revocations, and must never touch the current session.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

const session = (over: Record<string, unknown>) => ({
  id: 's1',
  deviceLabel: null,
  userAgent: CHROME,
  createdAt: ago(21 * DAY),
  lastUsedAt: ago(2 * 3600_000),
  revoked: false,
  current: false,
  ...over,
});

interface Setup {
  sessions?: ReturnType<typeof session>[];
  revoke?: (id: string) => Promise<unknown>;
  list?: () => Promise<unknown>;
}

/** Stateful, like the real server: a revoked session stays in the list, marked revoked. */
function mockApi(setup: Setup = {}) {
  const store = (setup.sessions ?? [session({ id: 'here', current: true }), session({ id: 'phone', userAgent: SAFARI })]).map((s) => ({ ...s }));
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: [] });
    if (url.includes('/v1/auth/sessions') && method === 'GET') return setup.list ? setup.list() : ok(store);
    const del = url.match(/\/v1\/auth\/sessions\/([^/?]+)$/);
    if (del && method === 'DELETE') {
      if (setup.revoke) return setup.revoke(del[1]);
      const found = store.find((s) => s.id === del[1]);
      if (found) found.revoked = true;
      return ok({ revoked: true });
    }
    return ok([]);
  });
}

function calls(fragment: string, method?: string) {
  return (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]: [string, RequestInit | undefined]) => String(url).includes(fragment) && (!method || (init?.method ?? 'GET').toUpperCase() === method),
  );
}

function renderPage() {
  return render(
    <AuthProvider>
      <DevicesPage />
    </AuthProvider>,
  );
}

const device = (id: string) => document.querySelector(`[data-device="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the list', () => {
  it('names each device readably, marks the one in your hand, and gives it no sign-out control', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Chrome · Windows');
    const here = device('here');
    expect(within(here).getByText('این دستگاه')).toBeInTheDocument();
    expect(within(here).queryByRole('button', { name: /خروج از دستگاه/ })).toBeNull();
    expect(within(here).getByText(/«خروج از حساب»/)).toBeInTheDocument();
    expect(within(device('phone')).getByText('Safari · iOS')).toBeInTheDocument();
    expect(within(device('phone')).getByRole('button', { name: 'خروج از دستگاه Safari · iOS' })).toBeInTheDocument();
  });

  it('puts the current device first, then the most recently used, and hides devices already signed out', async () => {
    mockApi({
      sessions: [
        session({ id: 'old', userAgent: FIREFOX, lastUsedAt: ago(30 * DAY) }),
        session({ id: 'gone', revoked: true }),
        session({ id: 'recent', userAgent: SAFARI, lastUsedAt: ago(3600_000) }),
        session({ id: 'here', current: true, lastUsedAt: ago(60 * DAY) }),
      ],
    });
    renderPage();
    await screen.findByText('Firefox · Linux');
    const order = [...document.querySelectorAll('[data-device]')].map((el) => (el as HTMLElement).dataset.device);
    expect(order).toEqual(['here', 'recent', 'old']);
    expect(device('gone')).toBeNull();
  });

  it('writes when in words, and labels each row as a group for a screen reader', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Chrome · Windows');
    const here = device('here');
    expect(here).toHaveAttribute('role', 'group');
    expect(here.getAttribute('aria-label')).toMatch(/^دستگاه، Chrome · Windows، آخرین استفاده ۲ ساعت پیش$/);
    expect(here).toHaveTextContent('ورود: ۳ هفته پیش');
  });

  it('shows a device label the client sent, isolated left-to-right', async () => {
    mockApi({ sessions: [session({ id: 'here', current: true, deviceLabel: 'Sara-Laptop' })] });
    renderPage();
    const label = await screen.findByText('Sara-Laptop');
    expect(label.className).toContain('label');
  });

  it('offers a retry when the list fails to load', async () => {
    let attempt = 0;
    mockApi({ list: () => (++attempt === 1 ? fail(500, 'X', 'خطای سرور') : ok([session({ id: 'here', current: true })])) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByText('Chrome · Windows')).toBeInTheDocument();
  });
});

describe('when no device is marked as current', () => {
  const stale = () => mockApi({ sessions: [session({ id: 'a' }), session({ id: 'b', userAgent: SAFARI })] });

  it('is not an error: it says which is yours is not known yet, and marks nothing', async () => {
    stale();
    renderPage();
    await screen.findByText('Chrome · Windows');
    expect(screen.getByText(/کدام دستگاه شماست هنوز مشخص نشده/)).toHaveAttribute('role', 'status');
    expect(screen.queryByText('این دستگاه')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses the bulk action rather than guess, and says why', async () => {
    stale();
    renderPage();
    await screen.findByText('Chrome · Windows');
    expect(screen.getByRole('button', { name: 'خروج از همهٔ دستگاه‌های دیگر' })).toBeDisabled();
    expect(screen.getByText(/تا مشخص نشود کدام دستگاه شماست/)).toBeInTheDocument();
  });

  it('warns a single sign-out that it may be this very device', async () => {
    stale();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Chrome · Windows');
    await user.click(within(device('a')).getByRole('button', { name: /خروج از دستگاه/ }));
    expect(within(device('a')).getByText(/اگر این دستگاه خودِ شماست، از حساب خارج می‌شوید/)).toBeInTheDocument();
  });
});

describe('signing one device out', () => {
  it('asks a short question in the row — not a dialog — and does nothing until it is answered', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(within(device('phone')).getByRole('button', { name: /خروج از دستگاه/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(device('phone')).getByText(/باید دوباره وارد شود/)).toBeInTheDocument();
    expect(calls('/v1/auth/sessions/phone', 'DELETE')).toHaveLength(0);
    await user.click(within(device('phone')).getByRole('button', { name: 'انصراف' }));
    expect(calls('/v1/auth/sessions/phone', 'DELETE')).toHaveLength(0);
    expect(within(device('phone')).getByRole('button', { name: /خروج از دستگاه/ })).toBeInTheDocument();
  });

  it('revokes that one session by its id, drops the row at once, and announces it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(within(device('phone')).getByRole('button', { name: /خروج از دستگاه/ }));
    await user.click(within(device('phone')).getByRole('button', { name: 'بله، خارج شود' }));
    await waitFor(() => expect(device('phone')).toBeNull());
    expect(calls('/v1/auth/sessions/phone', 'DELETE')).toHaveLength(1);
    expect(screen.getByText('از دستگاه Safari · iOS خارج شد.')).toBeInTheDocument();
    expect(device('here')).not.toBeNull();
  });

  it('keeps the row and shows the server’s sentence when it refuses', async () => {
    mockApi({ revoke: () => fail(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(within(device('phone')).getByRole('button', { name: /خروج از دستگاه/ }));
    await user.click(within(device('phone')).getByRole('button', { name: 'بله، خارج شود' }));
    expect(await within(device('phone')).findByRole('alert')).toHaveTextContent('این مورد یافت نشد.');
    expect(device('phone')).not.toBeNull();
  });
});

describe('signing every other device out', () => {
  const three = () =>
    mockApi({
      sessions: [
        session({ id: 'here', current: true }),
        session({ id: 'phone', userAgent: SAFARI }),
        session({ id: 'old', userAgent: FIREFOX }),
      ],
    });

  it('is disabled, not hidden, when there is only this device — and says why', async () => {
    mockApi({ sessions: [session({ id: 'here', current: true })] });
    renderPage();
    await screen.findByText('Chrome · Windows');
    expect(screen.getByRole('button', { name: 'خروج از همهٔ دستگاه‌های دیگر' })).toBeDisabled();
    expect(screen.getByText('دستگاه دیگری با حساب شما وارد نشده است.')).toBeInTheDocument();
  });

  it('says plainly that you are not signed out, before asking', async () => {
    three();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(screen.getByRole('button', { name: 'خروج از همهٔ دستگاه‌های دیگر' }));
    expect(within(await screen.findByRole('dialog')).getByText(/شما از حساب خارج نمی‌شوید/)).toBeInTheDocument();
    expect(calls('/v1/auth/sessions/', 'DELETE')).toHaveLength(0);
  });

  it('revokes each OTHER session by its id, never the current one, and never calls logout-all-devices', async () => {
    three();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(screen.getByRole('button', { name: 'خروج از همهٔ دستگاه‌های دیگر' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'خروج از دستگاه‌های دیگر' }));

    await waitFor(() => expect(calls('/v1/auth/sessions/', 'DELETE')).toHaveLength(2));
    const revoked = calls('/v1/auth/sessions/', 'DELETE').map(([url]: [string]) => url.split('/').pop());
    expect(revoked.sort()).toEqual(['old', 'phone']);
    expect(calls('logout-all-devices')).toHaveLength(0);
    await waitFor(() => expect(device('phone')).toBeNull());
    expect(device('old')).toBeNull();
    expect(device('here')).not.toBeNull();
    expect(await screen.findByText('از همهٔ دستگاه‌های دیگر خارج شد.')).toBeInTheDocument();
  });

  it('says how many it could not sign out, and keeps those in the list', async () => {
    let n = 0;
    mockApi({
      sessions: [session({ id: 'here', current: true }), session({ id: 'phone', userAgent: SAFARI }), session({ id: 'old', userAgent: FIREFOX })],
      revoke: () => (++n === 1 ? fail(500, 'X', 'خطا') : ok({ revoked: true })),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Safari · iOS');
    await user.click(screen.getByRole('button', { name: 'خروج از همهٔ دستگاه‌های دیگر' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'خروج از دستگاه‌های دیگر' }));
    expect(await screen.findByText('از یک دستگاه خارج نشد. دوباره تلاش کنید.')).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
