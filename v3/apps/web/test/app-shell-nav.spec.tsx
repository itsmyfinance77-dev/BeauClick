import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppShell } from '@/components/app-shell';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';

let pathname = '/';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => pathname,
}));

/**
 * The customer shell — `V3_INFORMATION_ARCHITECTURE.md` §1–§2.
 *
 * ## The fault this replaces
 *
 * Eleven equally weighted destinations in one bar, about 606px wide at 1280
 * and three rows on a phone, with «خروج» at the same weight as «جست‌وجو» and
 * two seller destinations sitting in a customer's navigation.
 *
 * Three levels replace it, and what these cases pin is the SEPARATION rather
 * than the list: a destination that has moved into the avatar menu must not
 * still be in the header, or the reorganisation has changed nothing and only
 * added a menu. So the header assertions are mostly negative.
 *
 * ## What jsdom can and cannot say here
 *
 * The bottom bar is hidden above 640px by a media query, and jsdom computes
 * no styles, so every element is "present" to these cases regardless of
 * width. Structure, destinations, `aria-current`, focus and the menu's
 * keyboard behaviour are asserted here; which of the two navigations is
 * VISIBLE at a given width is a browser claim and is not made here.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function mockApi(
  options: { capabilities?: string[]; roles?: string[]; displayName?: string | null; unread?: number; chatUnread?: number | 'fail' } = {},
) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({
        id: 'u1',
        phone: '+989123456789',
        // `in`, not `??`: an explicit null is the case under test, and
        // nullish-coalescing would quietly restore the default name.
        displayName: 'displayName' in options ? options.displayName : 'مینا رضایی',
        roles: options.roles ?? [],
        capabilities: options.capabilities ?? [],
      });
    }
    if (url.includes('/v1/me/notifications')) {
      return ok({ items: [], unreadCount: options.unread ?? 0 });
    }
    if (url.includes('/v1/chat/unread-count')) {
      if (options.chatUnread === 'fail') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ data: null, meta: null, error: { code: 'X', message: 'x' } }) });
      }
      return ok({ total: options.chatUnread ?? 0, conversations: options.chatUnread ? 1 : 0 });
    }
    return ok([]);
  });
}

function renderShell() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AppShell>
          <p>محتوا</p>
        </AppShell>
      </UnreadProvider>
    </AuthProvider>,
  );
}

/** The primary bar, addressed by its accessible name rather than by position. */
function header(): HTMLElement {
  return screen.getByRole('navigation', { name: 'ناوبری اصلی' });
}

async function signedIn(options?: Parameters<typeof mockApi>[0]) {
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
  mockApi(options);
  renderShell();
  await screen.findByTestId('avatar-menu');
}

beforeEach(() => {
  pathname = '/';
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
});

describe('the header holds three destinations, not eleven', () => {
  it('offers only search, professionals and sign-in when signed out', async () => {
    mockApi();
    renderShell();

    await waitFor(() => expect(within(header()).getAllByRole('link')).toHaveLength(2));
    expect(within(header()).getByRole('link', { name: 'خدمات' })).toHaveAttribute('href', '/search');
    expect(within(header()).getByRole('link', { name: 'متخصص‌ها' })).toHaveAttribute('href', '/providers');
    expect(screen.getByRole('link', { name: 'ورود' })).toHaveAttribute('href', '/auth');
    // Nothing to sign out of, and no account to open.
    expect(screen.queryByTestId('avatar-menu')).toBeNull();
  });

  it('adds exactly one destination when signed in, and no more', async () => {
    await signedIn();

    const links = within(header()).getAllByRole('link').map((a) => a.getAttribute('href'));
    // The third destination is the umbrella page the information architecture names, not the bookings list underneath it.
    expect(links).toEqual(['/search', '/providers', '/dashboard']);
  });

  it('keeps the eight low-frequency destinations OUT of the header', async () => {
    await signedIn({ capabilities: ['bc_manage_platform'] });

    // The reorganisation only means something if these left. A menu that
    // duplicates the bar is a longer bar.
    const inHeader = within(header()).getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const moved of ['/journey', '/loyalty', '/waitlist', '/finance', '/business', '/admin']) {
      expect(inHeader).not.toContain(moved);
    }
    // And «خروج» is no longer a peer of «جست‌وجو».
    expect(within(header()).queryByText('خروج')).toBeNull();
  });

  it('marks the current destination for assistive technology, not only in colour', async () => {
    pathname = '/providers';
    await signedIn();

    expect(within(header()).getByRole('link', { name: 'متخصص‌ها' })).toHaveAttribute('aria-current', 'page');
    expect(within(header()).getByRole('link', { name: 'خدمات' })).not.toHaveAttribute('aria-current');
  });

  it('puts the unread count in the bell’s accessible name rather than beside it', async () => {
    await signedIn({ unread: 3 });

    await waitFor(() => expect(screen.getByRole('link', { name: /اعلان‌ها/ })).toBeInTheDocument());
    const bell = screen.getByRole('link', { name: /اعلان‌ها/ });
    // "اعلان‌ها، ۳ خوانده‌نشده" rather than a bare digit read out next to a link.
    expect(bell.getAttribute('aria-label')).toBe('اعلان‌ها، ۳ خوانده‌نشده');
    expect(bell).toHaveAttribute('href', '/notifications');
  });
});

describe('the avatar menu', () => {
  it('is closed until asked, and then holds what left the header', async () => {
    await signedIn();

    const trigger = screen.getByRole('button', { name: /حساب کاربری/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('avatar-menu-items')).toBeNull();

    await userEvent.click(trigger);
    const menu = screen.getByTestId('avatar-menu-items');
    const hrefs = within(menu).getAllByRole('link').map((a) => a.getAttribute('href'));
    // No «حالت متخصص»: this session owns no professional profile. No '/dashboard' either — it is a header destination now.
    expect(hrefs).toEqual(['/journey', '/loyalty', '/waitlist', '/finance', '/business']);
    expect(within(menu).getByRole('button', { name: 'خروج' })).toBeInTheDocument();
  });

  /**
   * `V3_INFORMATION_ARCHITECTURE.md` §2 level three: «حالت متخصص» belongs to a
   * user who owns a professional profile. It was offered to every signed-in
   * customer in two places at once, and following it reached `ProGuard`'s
   * "you have no profile yet" state — an invitation to a dead end.
   *
   * The role is the right test: `professional` is granted in the same
   * transaction as the profile row (#75) and the existing owners were
   * backfilled, and `/v1/me` resolves it live.
   */
  it('offers «حالت متخصص» nowhere to a customer who owns no professional profile', async () => {
    await signedIn();
    expect(screen.queryByRole('link', { name: 'حالت متخصص' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    const menu = screen.getByTestId('avatar-menu-items');
    expect(within(menu).queryByRole('link', { name: 'حالت متخصص' })).toBeNull();
    expect(within(menu).getAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain('/pro');
  });

  it('offers it in both places to a seller', async () => {
    await signedIn({ roles: ['customer', 'professional'] });
    expect(screen.getByRole('link', { name: 'حالت متخصص' })).toHaveAttribute('href', '/pro');

    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    const menu = screen.getByTestId('avatar-menu-items');
    expect(within(menu).getByRole('link', { name: 'حالت متخصص' })).toHaveAttribute('href', '/pro');
  });

  it('shows the platform destination only to a session that holds the capability', async () => {
    await signedIn();
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    expect(within(screen.getByTestId('avatar-menu-items')).queryByRole('link', { name: 'مدیریت' })).toBeNull();
  });

  it('shows it to one that does', async () => {
    await signedIn({ capabilities: ['bc_manage_platform'] });
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    expect(within(screen.getByTestId('avatar-menu-items')).getByRole('link', { name: 'مدیریت' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  // #264, `51_WORKSPACE_SHELL_AND_DASHBOARDS.md` §2.2: one admin shell, two
  // labels. A moderation-only session is offered the SAME /admin under its
  // own name, and never the platform one.
  it('offers a moderation-only session «بررسی محتوا», and not «مدیریت»', async () => {
    await signedIn({ capabilities: ['bc_moderate_media'] });
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    const menu = screen.getByTestId('avatar-menu-items');
    expect(within(menu).getByRole('link', { name: 'بررسی محتوا' })).toHaveAttribute('href', '/admin');
    expect(within(menu).queryByRole('link', { name: 'مدیریت' })).toBeNull();
  });

  it('keeps «مدیریت» for a session that also holds the platform capability, and offers /admin once', async () => {
    await signedIn({ capabilities: ['bc_manage_platform', 'bc_moderate_verification', 'bc_moderate_chat'] });
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    const menu = screen.getByTestId('avatar-menu-items');
    expect(within(menu).getByRole('link', { name: 'مدیریت' })).toHaveAttribute('href', '/admin');
    expect(within(menu).queryByRole('link', { name: 'بررسی محتوا' })).toBeNull();
    expect(within(menu).getAllByRole('link').filter((a) => a.getAttribute('href') === '/admin')).toHaveLength(1);
  });

  it('closes on Escape and gives focus back to the control that opened it', async () => {
    await signedIn();
    const trigger = screen.getByRole('button', { name: /حساب کاربری/ });

    await userEvent.click(trigger);
    expect(screen.getByTestId('avatar-menu-items')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('avatar-menu-items')).toBeNull());
    // Focus left somewhere reachable, not on a removed node.
    expect(trigger).toHaveFocus();
  });

  it('names the account without putting a phone number in the trigger', async () => {
    await signedIn({ displayName: null });

    const trigger = screen.getByRole('button', { name: /حساب کاربری/ });
    // A nameless account falls back to a neutral word. The number belongs
    // inside the menu, in its own LTR run, not on the page chrome.
    expect(trigger.textContent).toContain('حساب من');
    expect(trigger.textContent).not.toContain('989123456789');

    await userEvent.click(trigger);
    expect(screen.getByTestId('avatar-menu-items').textContent).toContain('+989123456789');
  });
});

// #237, `35_AI_ASSISTANT.md` §17: «دستیار» is a new level-one destination for a
// session holding `bc_use_ai_assistant`, and nothing at all for one without it.
// On a phone the header links are hidden, so the same destination is ALSO in the
// avatar menu there — marked phone-only, so the wide header does not carry it
// twice (which one is visible at a width is a browser claim, measured there).
describe('the assistant entry', () => {
  it('is absent — from the header and the menu — without the capability', async () => {
    await signedIn();
    expect(within(header()).queryByRole('link', { name: 'دستیار' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    expect(within(screen.getByTestId('avatar-menu-items')).queryByRole('link', { name: 'دستیار هوشمند' })).toBeNull();
  });

  it('is the fourth header destination for a session that holds it', async () => {
    await signedIn({ capabilities: ['bc_use_ai_assistant'] });
    expect(within(header()).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/search',
      '/providers',
      '/dashboard',
      '/assistant',
    ]);
  });

  it('is in the avatar menu as a phone-only entry, first of the occasional destinations', async () => {
    await signedIn({ capabilities: ['bc_use_ai_assistant'] });
    await userEvent.click(screen.getByRole('button', { name: /حساب کاربری/ }));
    const entry = within(screen.getByTestId('avatar-menu-items')).getByRole('link', { name: 'دستیار هوشمند' });
    expect(entry).toHaveAttribute('href', '/assistant');
    expect(entry.className).toContain('menuItemPhoneOnly');
  });

  it('marks the assistant current on its own page', async () => {
    pathname = '/assistant';
    await signedIn({ capabilities: ['bc_use_ai_assistant'] });
    expect(within(header()).getByRole('link', { name: 'دستیار' })).toHaveAttribute('aria-current', 'page');
  });
});

// #328, spec 51 §2.1: the messages entry — only for `bc_use_chat`, the count in
// its accessible name, no badge at 0 and none (and no number) on a failed read.
describe('the messages entry', () => {
  it('is absent without bc_use_chat, and no unread count is read', async () => {
    await signedIn();
    expect(screen.queryByTestId('header-messages')).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('/v1/chat/'))).toBe(false);
  });

  it('opens the whole inbox and carries the server`s unread total in its name', async () => {
    await signedIn({ capabilities: ['bc_use_chat'], chatUnread: 3 });
    const entry = await screen.findByRole('link', { name: 'پیام‌ها، ۳ خوانده‌نشده' });
    expect(entry).toHaveAttribute('href', '/messages');
    expect(entry).toHaveTextContent('۳');
  });

  it('draws no badge at zero', async () => {
    await signedIn({ capabilities: ['bc_use_chat'], chatUnread: 0 });
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('/v1/chat/unread-count'))).toBe(true));
    const entry = screen.getByTestId('header-messages');
    expect(entry).toHaveAccessibleName('پیام‌ها');
    expect(entry.textContent).toBe('');
  });

  it('draws no badge and no number when the count cannot be read', async () => {
    await signedIn({ capabilities: ['bc_use_chat'], chatUnread: 'fail' });
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([url]: [string]) => String(url).includes('/v1/chat/unread-count'))).toBe(true));
    const entry = screen.getByTestId('header-messages');
    expect(entry).toHaveAccessibleName('پیام‌ها');
    expect(entry.textContent).toBe('');
  });
});

describe('the mobile bar and the footer', () => {
  it('carries five destinations, each with its own glyph shape', async () => {
    await signedIn();

    const bar = screen.getByTestId('mobile-tab-bar');
    const tabs = [...bar.querySelectorAll('[data-tab]')].map((a) => a.getAttribute('data-tab'));
    expect(tabs).toEqual(['/', '/search', '/bookings', '/loyalty', '/dashboard']);

    // Shape as well as colour: the current tab must be identifiable without
    // relying on colour alone.
    const glyphClasses = [...bar.querySelectorAll('[data-tab] span')].map((s) => s.className);
    expect(new Set(glyphClasses).size).toBe(5);
  });

  it('marks the current tab and matches a subtree without matching the root', async () => {
    pathname = '/bookings/b1';
    await signedIn();

    const bar = screen.getByTestId('mobile-tab-bar');
    expect(bar.querySelector('[data-tab="/bookings"]')).toHaveAttribute('aria-current', 'page');
    // `/` is a prefix of every path; it must match only itself.
    expect(bar.querySelector('[data-tab="/"]')).not.toHaveAttribute('aria-current');
  });

  it.each(['/admin', '/admin/verification', '/pro', '/pro/bookings'])(
    // `25_MOBILE_NAVIGATION.md`: admin gets a dark horizontal scrolling bar
    // instead of any bottom bar, and pro carries its own two destinations plus
    // a sheet (`ProMobileNav`). Either way the customer's five are the wrong
    // ones here.
    'does not carry the customer bar on %s, which has its own nav chrome',
    async (route) => {
      pathname = route;
      await signedIn();
      expect(screen.queryByTestId('mobile-tab-bar')).toBeNull();
    },
  );

  it.each(['/products', '/prospect'])(
    'still carries it on %s, which only shares a prefix with a guarded route',
    async (route) => {
      pathname = route;
      await signedIn();
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    },
  );

  it('renders the footer on the landing page', async () => {
    await signedIn();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it.each(['/terms', '/privacy-policy', '/contact', '/support'])(
    'and on %s, which the footer links to and the spec draws it on',
    async (route) => {
      pathname = route;
      await signedIn();
      expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    },
  );

  it.each(['/search', '/bookings', '/account/privacy', '/terms/extra'])(
    'and not on %s, because no other artboard carries one',
    async (route) => {
      pathname = route;
      await signedIn();
      expect(screen.queryByRole('contentinfo')).toBeNull();
    },
  );

  it('gives the footer no link that leads nowhere', async () => {
    await signedIn();

    const footer = screen.getByRole('contentinfo');
    for (const link of within(footer).getAllByRole('link')) {
      // The prototype draws every footer link as `href="#"`. Each one here is
      // a route with a page behind it: checked against `app/` itself, not
      // against a list kept beside the test that could drift from it.
      const href = link.getAttribute('href') ?? '';
      expect(existsSync(join(__dirname, '..', 'app', href.slice(1), 'page.tsx'))).toBe(true);
    }
    // «درباره ما» is still drawn in the prototype and still has no route.
    expect(footer.textContent).not.toContain('درباره ما');
  });

  it('links the four legal and support pages, under the prototype\'s own column title', async () => {
    await signedIn();

    const nav = within(screen.getByRole('contentinfo')).getByRole('navigation', { name: 'پیوندهای بیوکلیک' });
    expect(nav).toHaveTextContent('بیوکلیک');
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['قوانین و مقررات', '/terms'],
      ['حریم خصوصی', '/privacy-policy'],
      ['تماس', '/contact'],
      ['پشتیبانی', '/support'],
    ]);
  });
});
