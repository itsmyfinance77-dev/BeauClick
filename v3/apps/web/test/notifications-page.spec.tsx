import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationsPage from '@/app/notifications/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/notifications',
}));

/**
 * The notification centre, against `18_NOTIFICATIONS.md`.
 *
 * The screen's job is to send someone somewhere, so the cases that matter are
 * the ones about where: a link that exists is followed, a link the server
 * names but this app cannot open is not rendered, and an unread item is
 * announced rather than only coloured.
 */

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });

const item = (over: Record<string, unknown>) => ({
  id: 'n1',
  category: 'booking',
  title: 'نوبت شما تأیید شد',
  body: 'نوبت شما برای فردا ثبت شد.',
  deepLink: '/bookings',
  read: false,
  createdAt: '2026-09-01T06:30:00.000Z',
  ...over,
});

const PREFERENCES = [
  { category: 'booking', enabled: true, mandatory: true },
  { category: 'retention', enabled: false, mandatory: false },
];

function mockApi(items: unknown[], unreadCount: number, extra: Record<string, () => Promise<unknown>> = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    for (const [fragment, handler] of Object.entries(extra)) if (url.includes(fragment)) return handler();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
    if (url.includes('/notifications/preferences')) return ok({ preferences: PREFERENCES });
    if (url.includes('/v1/me/notifications')) return ok({ items, unreadCount });
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <NotificationsPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-notification="${id}"]`) as HTMLElement;

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('notification centre', () => {
  it('announces an unread item and marks it with a dot, and leaves a read one plain', async () => {
    mockApi([item({ id: 'n1' }), item({ id: 'n2', read: true, title: 'قدیمی' })], 1);
    renderPage();
    await screen.findByText('نوبت شما تأیید شد');

    expect(row('n1')).toHaveAttribute('aria-label', 'خوانده‌نشده');
    expect(row('n1').querySelector('[aria-hidden="true"]')).not.toBeNull(); // the dot
    expect(row('n2')).not.toHaveAttribute('aria-label');
    expect(within(row('n2')).queryByRole('button', { name: 'خوانده شد' })).toBeNull();
  });

  it('prints the category as a word, not only as a tint', async () => {
    mockApi([item({ category: 'payment' })], 1);
    renderPage();
    await screen.findByText('نوبت شما تأیید شد');
    expect(within(row('n1')).getByText('پرداخت')).toBeInTheDocument();
  });

  it('links to a destination that exists', async () => {
    mockApi([item({ deepLink: '/waitlist' })], 1);
    renderPage();
    await screen.findByText('نوبت شما تأیید شد');
    expect(within(row('n1')).getByRole('link', { name: 'مشاهده' })).toHaveAttribute('href', '/waitlist');
  });

  // #328: the chat template names `/chat` — the inbox, never a thread.
  it('opens the inbox for a new-message notification', async () => {
    mockApi([item({ deepLink: '/chat' })], 1);
    renderPage();
    await screen.findByText('نوبت شما تأیید شد');
    expect(within(row('n1')).getByRole('link', { name: 'مشاهده' })).toHaveAttribute('href', '/messages');
  });

  it.each([
    ['a page that does not exist', '/somewhere-unbuilt'],
    ['an off-site address', 'https://evil.example/bookings'],
    ['a protocol-relative address', '//evil.example'],
    ['no link at all', null],
  ])('renders no «مشاهده» link for %s, but still shows the notification', async (_label, deepLink) => {
    mockApi([item({ deepLink })], 1);
    renderPage();
    await screen.findByText('نوبت شما تأیید شد');
    expect(within(row('n1')).queryByRole('link')).toBeNull();
    expect(within(row('n1')).getByRole('button', { name: 'خوانده شد' })).toBeInTheDocument();
  });

  it('puts «mark all read» above the list, only while something is unread', async () => {
    mockApi([item({ id: 'n1' })], 1);
    const { unmount } = renderPage();
    const button = await screen.findByRole('button', { name: 'علامت‌گذاری همه به‌عنوان خوانده‌شده' });
    const list = screen.getByRole('list');
    // DOCUMENT_POSITION_FOLLOWING: the list comes after the button.
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    mockApi([item({ id: 'n1', read: true })], 0);
    renderPage();
    await screen.findByText('همهٔ اعلان‌ها خوانده شده‌اند.');
    expect(screen.queryByRole('button', { name: 'علامت‌گذاری همه به‌عنوان خوانده‌شده' })).toBeNull();
  });

  it('marks everything read locally and takes the count from the server', async () => {
    mockApi([item({ id: 'n1' }), item({ id: 'n2', title: 'دوم' })], 2, {
      '/read-all': () => ok({ marked: 2, unreadCount: 0 }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'علامت‌گذاری همه به‌عنوان خوانده‌شده' }));
    await waitFor(() => expect(row('n1')).not.toHaveAttribute('aria-label'));
    expect(row('n2')).not.toHaveAttribute('aria-label');
  });

  it('shows a mandatory preference disabled with its reason beside it, not hidden', async () => {
    mockApi([item({})], 1);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'تنظیمات' }));

    const mandatory = screen.getByRole('checkbox', { name: /رزرو/ });
    expect(mandatory).toBeDisabled();
    expect(mandatory).toBeChecked();
    expect(screen.getByText(/همیشه فعال \(پیام‌های ضروری\)/)).toBeInTheDocument();

    const optional = screen.getByRole('checkbox', { name: /پیشنهادها/ });
    expect(optional).toBeEnabled();
  });
});
