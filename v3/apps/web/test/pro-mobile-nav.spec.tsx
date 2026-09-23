import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProShell } from '@/components/pro-shell';
import { PRO_NAV } from '@/components/pro-nav';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

let pathname = '/pro';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => pathname,
}));

/**
 * The professional's navigation below 640 — `25_MOBILE_NAVIGATION.md` and
 * `V3_INFORMATION_ARCHITECTURE.md` §3.
 *
 * Nine destinations in a column do not fit a phone. §3 keeps «امروز» and
 * «رزروها» on a bottom bar and sends the rest of the COLUMN — not just its
 * links — to a slide-up sheet, so the identity, the verification status and
 * the way back to the customer view have to survive the move too.
 *
 * jsdom applies no media queries, so both the column and the bar are in this
 * DOM at once. That is the point: which one a viewport sees is a stylesheet
 * decision, and these tests assert the part JavaScript is responsible for —
 * which destinations sit where, and how the sheet opens, closes and hands
 * focus back.
 */

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function mockApi(options: { verificationStatus?: string; hasProfile?: boolean } = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['professional'], capabilities: [] });
    }
    if (url.includes('/v1/me/provider')) {
      if (options.hasProfile === false) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ data: null, meta: null, error: { code: 'NOT_FOUND', message: 'no profile' } }),
        });
      }
      return ok({
        id: 'prof-1',
        displayName: 'سارا محمدی',
        verificationStatus: options.verificationStatus ?? 'verified',
      });
    }
    return ok([]);
  });
}

function shell() {
  return (
    <AuthProvider>
      <ProProvider>
        <ProShell>
          <p>محتوا</p>
        </ProShell>
      </ProProvider>
    </AuthProvider>
  );
}

function bar(): HTMLElement {
  return screen.getByTestId('mobile-tab-bar');
}

function trigger(): HTMLElement {
  return within(bar()).getByRole('button', { name: 'منو' });
}

function openSheet(): HTMLElement {
  fireEvent.click(trigger());
  return screen.getByTestId('pro-nav-sheet');
}

beforeEach(() => {
  pathname = '/pro';
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('the professional’s bottom bar', () => {
  it('carries the two destinations §3 names, and nothing else', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');

    const hrefs = [...bar().querySelectorAll('[data-tab]')].map((el) => el.getAttribute('data-tab'));
    // «امروز» و «رزروها» در نوار پایین می‌مانند — plus the one control that is
    // not a destination. Never five: the customer's five are the wrong five.
    expect(hrefs).toEqual(['/pro', '/pro/bookings', 'trigger']);
    expect(within(bar()).getByRole('link', { name: 'امروز' })).toHaveAttribute('href', '/pro');
    expect(within(bar()).getByRole('link', { name: 'رزروها' })).toHaveAttribute('href', '/pro/bookings');
  });

  it('is the one shared bar, not a second one built for the professional', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');

    // Spec 25: "یک جزء واحد ... تفاوت بسترها فقط در کدام مقصدها روی نوار
    // می‌نشینند، نه در جزء."
    expect(bar()).toHaveAttribute('aria-label', 'ناوبری موبایل');
  });

  it('marks the current destination, and «امروز» does not claim the whole subtree', async () => {
    pathname = '/pro/bookings';
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');

    expect(bar().querySelector('[data-tab="/pro/bookings"]')).toHaveAttribute('aria-current', 'page');
    expect(bar().querySelector('[data-tab="/pro"]')).not.toHaveAttribute('aria-current');
  });

  it('leaves no destination unreachable on a phone', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();

    const onBar = [...bar().querySelectorAll('[data-tab]')]
      .map((el) => el.getAttribute('data-tab'))
      .filter((href) => href !== 'trigger');
    const inSheet = [...sheet.querySelectorAll('[data-sheet-nav]')].map((el) => el.getAttribute('data-sheet-nav'));

    // The bar and the sheet are derived from one list, and this is the property
    // that derivation exists for: a destination added to the column cannot go
    // missing from the phone.
    expect([...onBar, ...inSheet].sort()).toEqual(PRO_NAV.map((item) => item.href).sort());
    expect(inSheet).toHaveLength(7);
  });
});

describe('the sheet', () => {
  it('opens from the menu button and announces itself as a dialog', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');

    expect(screen.queryByTestId('pro-nav-sheet')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    const sheet = openSheet();
    expect(sheet).toHaveAttribute('role', 'dialog');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // The relationship is announced, not only drawn.
    expect(trigger().getAttribute('aria-controls')).toBe(sheet.getAttribute('id'));
    expect(sheet).toHaveAccessibleName('مقصدهای دیگر');
  });

  it('holds the other seven destinations in the column’s order, and the way out', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();

    expect([...sheet.querySelectorAll('[data-sheet-nav]')].map((el) => el.getAttribute('data-sheet-nav'))).toEqual([
      '/pro/availability',
      '/pro/services',
      '/pro/finance',
      '/pro/analytics',
      '/pro/outcome-policy',
      '/pro/profile',
      '/business',
    ]);
    // The column's foot, which a phone would otherwise lose entirely.
    expect(within(sheet).getByRole('link', { name: /بازگشت به نمای مشتری/ })).toHaveAttribute('href', '/');
  });

  it('carries the identity and the real verification status the column head shows', async () => {
    mockApi({ verificationStatus: 'pending' });
    render(shell());
    await screen.findByTestId('pro-identity');
    openSheet();

    const identity = screen.getByTestId('pro-sheet-identity');
    expect(identity.textContent).toContain('سارا محمدی');
    // The true status, not a flattering one — and as text, not a colour.
    expect(identity.textContent).toContain('در انتظار بررسی');
  });

  it('opens for a professional with no profile yet, rather than stranding them', async () => {
    mockApi({ hasProfile: false });
    render(shell());
    await waitFor(() => expect(bar().querySelectorAll('[data-tab]').length).toBeGreaterThan(0));

    const sheet = openSheet();
    expect(within(sheet).getByRole('link', { name: 'پروفایل عمومی' })).toBeInTheDocument();
    expect(screen.queryByTestId('pro-sheet-identity')).toBeNull();
  });

  it('marks the current destination inside itself', async () => {
    pathname = '/pro/services';
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();

    expect(sheet.querySelector('[data-sheet-nav="/pro/services"]')).toHaveAttribute('aria-current', 'page');
    expect(sheet.querySelector('[data-sheet-nav="/pro/finance"]')).not.toHaveAttribute('aria-current');
  });

  it('moves focus into itself on open and back to the trigger on close', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');

    const sheet = openSheet();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));

    fireEvent.click(within(sheet).getByRole('button', { name: 'بستن' }));
    await waitFor(() => expect(screen.queryByTestId('pro-nav-sheet')).toBeNull());
    // A keyboard user who opened it must not be dropped at the top of the page.
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on Escape', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    openSheet();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('pro-nav-sheet')).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps Tab inside itself', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();

    const focusables = [...sheet.querySelectorAll<HTMLElement>('button, [href]')];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Without the wrap, Tab from the last link lands on the page behind a
    // dialog that claims to be modal.
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('lets the keyboard go once a widened viewport has hidden it', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();

    // The stylesheet, not this component, decides that 640 and up gets no
    // sheet; standing in for it here is the same thing the media query does.
    screen.getByTestId('pro-nav-scrim').style.display = 'none';

    const focusables = [...sheet.querySelectorAll<HTMLElement>('button, [href]')];
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    // No wrap: Tab belongs to the page a professional can actually see.
    expect(document.activeElement).toBe(last);
  });

  it('closes on a tap on the scrim, but not on a drag that started inside it', async () => {
    mockApi();
    render(shell());
    await screen.findByTestId('pro-identity');
    const sheet = openSheet();
    const scrim = screen.getByTestId('pro-nav-scrim');

    // A selection dragged out of the panel ends in a click on the scrim.
    fireEvent.mouseDown(sheet);
    fireEvent.click(scrim);
    expect(screen.getByTestId('pro-nav-sheet')).toBeInTheDocument();

    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    await waitFor(() => expect(screen.queryByTestId('pro-nav-sheet')).toBeNull());
  });

  it('closes when the route changes, so it never sits over a page it navigated to', async () => {
    mockApi();
    const view = render(shell());
    await screen.findByTestId('pro-identity');
    openSheet();

    pathname = '/pro/finance';
    view.rerender(shell());

    await waitFor(() => expect(screen.queryByTestId('pro-nav-sheet')).toBeNull());
  });
});
