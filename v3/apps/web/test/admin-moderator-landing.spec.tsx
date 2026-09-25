import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AdminLayout from '@/app/admin/layout';
import AdminIndexPage from '@/app/admin/page';
import AdminVerificationPage from '@/app/admin/verification/page';
import AdminMediaPage from '@/app/admin/media/page';
import AdminReviewsPage from '@/app/admin/reviews/page';
import AdminChatReportsPage from '@/app/admin/chat-reports/page';
import AdminUsersPage from '@/app/admin/users/page';
import AdminAuditLogPage from '@/app/admin/audit-log/page';
import AdminSettlementsPage from '@/app/admin/settlements/page';
import AdminPrivacyPage from '@/app/admin/privacy/page';
import AdminSearchPage from '@/app/admin/search/page';
import AdminNotificationsPage from '@/app/admin/notifications/page';
import AdminPhoneConflictsPage from '@/app/admin/phone-conflicts/page';
import AdminLoyaltyPage from '@/app/admin/loyalty/page';
import AdminPlansPage from '@/app/admin/commercial/plans/page';
import AdminCommissionPoliciesPage from '@/app/admin/commercial/commission-policies/page';
import AdminOutcomePolicyPage from '@/app/admin/commercial/outcome-policy/page';
import AdminControlPlanePage from '@/app/admin/commercial/control-plane/page';
import { AdminGuard } from '@/components/admin-guard';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';
import {
  CHAT_REPORT_COUNT_LIMIT,
  MODERATION_QUEUES,
  adminMode,
  heldModerationQueues,
  isModerationRoute,
  queueCountWording,
} from '@/lib/admin-access';

let mockPathname = '/admin';
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
}));

/**
 * #264 — moderators reach the moderation queues, and nothing else.
 *
 * `52_MODERATOR_LANDING.md`, approved recommendation A: one shared admin shell,
 * a capability-driven landing at `/admin` for a caller holding moderation
 * capabilities and NOT `bc_manage_platform`, and the operator's and
 * administrator's `/admin` unchanged.
 *
 * As everywhere in `apps/web`, what is tested here is the EXPLANATION and the
 * OFFER, not the control. The control is `CapabilityGuard`; the server half of
 * this story — a moderator refused on every `bc_manage_platform` and
 * `bc_manage_commercial_plans` route — is proven against a real database in
 * `apps/api/test/moderator-admin-boundary.pg-spec.ts`.
 */

// ------------------------------------------------------------------ the fake API

type Reply = { status: number; body: unknown } | 'network';

const ok = (data: unknown, meta: unknown = null): Reply => ({ status: 200, body: { data, meta, error: null } });
const page = (total: number): Reply => ok([], { pagination: { page: 1, limit: 1, total } });
const forbidden = (): Reply => ({
  status: 403,
  body: { data: null, meta: null, error: { code: 'FORBIDDEN', message: 'اجازه دسترسی به این بخش را ندارید.' } },
});

/** What `/v1/me` answers. Mutable, because `/v1/me` is LIVE on the server. */
let caps: string[] = [];
/** Per-path replies for this case; anything unlisted under `/v1/admin/` is refused. */
let routes: Record<string, () => Reply> = {};
/** Every request, as `path?query`, in order. */
let calls: string[] = [];

const DEFAULT_ROUTES: Record<string, () => Reply> = {
  '/v1/admin/verification/queue': () => page(3),
  '/v1/admin/media/reports': () => page(12),
  '/v1/admin/reviews/queue': () => page(0),
  '/v1/admin/chat/reports': () => ok({ items: Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` })) }),
};

function installApi(capabilities: string[], overrides: Record<string, () => Reply> = {}) {
  caps = capabilities;
  routes = { ...DEFAULT_ROUTES, ...overrides };
  calls = [];
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/api/, '');
    calls.push(`${path}${parsed.search}`);
    let reply: Reply;
    if (path === '/v1/auth/refresh') reply = ok({ accessToken: 'a', csrfToken: 'c' });
    else if (path === '/v1/me') {
      reply = ok({ id: 'u1', phone: '+989123456789', displayName: 'ناظر محتوا', roles: [], capabilities: caps });
    } else if (routes[path]) reply = routes[path]();
    // The server's answer to every admin route this fake was not told about:
    // refused. A page that asked for one would show up in `calls` below.
    else if (path.startsWith('/v1/admin/')) reply = forbidden();
    else reply = ok([]);
    if (reply === 'network') throw new TypeError('Failed to fetch');
    const { status, body } = reply;
    return { ok: status < 400, status, json: async () => body };
  });
}

/** Admin requests only, without the query. */
function adminCalls(): string[] {
  return calls.filter((c) => c.startsWith('/v1/admin/')).map((c) => c.split('?')[0]);
}

function meReads(): number {
  return calls.filter((c) => c === '/v1/me').length;
}

// ------------------------------------------------------------------ rendering

/** Lets a case trigger "the next `/v1/me` read" the way the app does. */
function ReloadProbe() {
  const { reloadUser } = useAuth();
  return (
    <button type="button" onClick={() => void reloadUser()}>
      re-read me
    </button>
  );
}

function tree(node: React.ReactElement, withLayout = true) {
  return (
    <AuthProvider>
      <UnreadProvider>
        <ReloadProbe />
        {withLayout ? <AdminLayout>{node}</AdminLayout> : node}
      </UnreadProvider>
    </AuthProvider>
  );
}

function renderAt(pathname: string, node: React.ReactElement, withLayout = true) {
  mockPathname = pathname;
  return render(tree(node, withLayout));
}

function bar(): HTMLElement {
  return screen.getByTestId('admin-bar');
}

function navLinks(): Array<[string | null, string]> {
  return within(screen.getByRole('navigation', { name: 'ناوبری مدیریت' }))
    .getAllByRole('link')
    .map((a) => [a.getAttribute('href'), a.textContent ?? '']);
}

/** The landing's list of cards. */
function landingList(): HTMLElement {
  return screen.getByTestId('moderation-queues');
}

function landingCards(): HTMLElement[] {
  return within(landingList()).getAllByRole('listitem');
}

/** Resolves once the landing has cards and none is still loading. */
async function settled() {
  await waitFor(() => {
    expect(document.querySelectorAll('[data-queue][data-state]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-state="loading"]')).toBeNull();
  });
}

async function reReadMe() {
  const before = meReads();
  await userEvent.click(screen.getByRole('button', { name: 're-read me' }));
  await waitFor(() => expect(meReads()).toBeGreaterThan(before));
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
  mockRouter.replace.mockClear();
  mockRouter.push.mockClear();
  mockPathname = '/admin';
});

const ALL_MODERATION = ['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_media', 'bc_moderate_chat'];
const ADMINISTRATOR = ['bc_manage_platform', ...ALL_MODERATION, 'bc_manage_commercial_plans', 'bc_manage_own_profile'];
const OPERATOR = ['bc_manage_platform'];

/** The admin routes each moderation capability may read from the landing. */
const LANDING_READS: Record<string, string> = {
  bc_moderate_verification: '/v1/admin/verification/queue',
  bc_moderate_media: '/v1/admin/media/reports',
  bc_moderate_reviews: '/v1/admin/reviews/queue',
  bc_moderate_chat: '/v1/admin/chat/reports',
};

/**
 * The bar exactly as it was before #264, for the two roles whose experience
 * the contract says is unchanged. Written out rather than derived from
 * `ADMIN_NAV`, so a change to that list shows up here as a diff to review.
 */
const ADMINISTRATOR_NAV: Array<[string, string]> = [
  ['/admin', 'نمای کلی'],
  ['/admin/verification', 'احراز هویت'],
  ['/admin/media', 'گزارش تصاویر'],
  ['/admin/reviews', 'بازبینی دیدگاه‌ها'],
  ['/admin/chat-reports', 'گزارش گفتگوها'],
  ['/admin/users', 'کاربران و نقش‌ها'],
  ['/admin/audit-log', 'گزارش عملیات'],
  ['/admin/privacy', 'حریم خصوصی'],
  ['/admin/settlements', 'تسویه‌ها'],
  ['/admin/search', 'جست‌وجو'],
  ['/admin/notifications', 'اعلان‌ها'],
  ['/admin/phone-conflicts', 'تعارض شماره'],
  ['/admin/loyalty', 'باشگاه'],
  ['/admin/commercial/plans', 'طرح‌ها و قیمت'],
  ['/admin/commercial/commission-policies', 'سیاست کمیسیون'],
  ['/admin/commercial/outcome-policy', 'سیاست پیامد'],
  ['/admin/commercial/control-plane', 'دریافت و اعمال اعتبار'],
];
const MODERATION_HREFS = ['/admin/verification', '/admin/media', '/admin/reviews', '/admin/chat-reports'];
const OPERATOR_NAV = ADMINISTRATOR_NAV.filter(
  ([href]) => !MODERATION_HREFS.includes(href) && !href.startsWith('/admin/commercial/'),
);

// =============================================================================
// The access model — pure
// =============================================================================

describe('adminMode — who gets which /admin', () => {
  it.each([
    ['administrator', ADMINISTRATOR, 'platform'],
    ['platform operator', OPERATOR, 'platform'],
    ['full moderator', ALL_MODERATION, 'moderation'],
    ['partial moderator', ['bc_moderate_media', 'bc_moderate_chat'], 'moderation'],
    ['one-capability moderator', ['bc_moderate_reviews'], 'moderation'],
    ['customer', ['bc_book_service', 'bc_use_chat'], null],
    ['professional', ['bc_manage_own_profile', 'bc_view_own_finance'], null],
    // Spec 52 §2: does not occur in the role map, and gets no landing of its own.
    ['commercial without platform', ['bc_manage_commercial_plans'], null],
    ['nothing at all', [], null],
  ])('%s → %s', (_name, capabilities, mode) => {
    expect(adminMode(capabilities)).toBe(mode);
  });

  it('never reads a lookalike slug as a moderation capability', () => {
    expect(adminMode(['bc_moderate', 'bc_moderate_everything', 'bc_moderate_verification_x'])).toBeNull();
  });

  it('lists held queues in the fixed order, whatever order /v1/me returns them in', () => {
    const held = heldModerationQueues(['bc_moderate_chat', 'bc_moderate_verification', 'bc_moderate_media']);
    expect(held.map((q) => q.href)).toEqual(['/admin/verification', '/admin/media', '/admin/chat-reports']);
    expect(MODERATION_QUEUES.map((q) => q.capability)).toEqual([
      'bc_moderate_verification',
      'bc_moderate_media',
      'bc_moderate_reviews',
      'bc_moderate_chat',
    ]);
  });

  it('admits only the landing and the four queue routes in moderation mode', () => {
    for (const ok of ['/admin', '/admin/verification', '/admin/media', '/admin/reviews', '/admin/chat-reports']) {
      expect(isModerationRoute(ok)).toBe(true);
    }
    for (const refused of [
      '/admin/users',
      '/admin/audit-log',
      '/admin/settlements',
      '/admin/privacy',
      '/admin/search',
      '/admin/notifications',
      '/admin/phone-conflicts',
      '/admin/loyalty',
      '/admin/commercial/plans',
      '/admin/commercial/commission-policies',
      '/admin/commercial/outcome-policy',
      '/admin/commercial/control-plane',
      // A prefix is not a subtree.
      '/admin/mediation',
      '/admin/verification-log',
      '/administrator',
      '/admin/',
    ]) {
      expect(isModerationRoute(refused)).toBe(false);
    }
  });
});

describe('queueCountWording — spec 52 §3, exactly', () => {
  it('says a paginated total as the server returned it', () => {
    expect(queueCountWording({ kind: 'exact', value: 12 })).toBe('۱۲ مورد در صف');
    expect(queueCountWording({ kind: 'exact', value: 1 })).toBe('۱ مورد در صف');
  });

  it('says the chat count exactly only below the limit', () => {
    expect(queueCountWording({ kind: 'bounded', value: 49, limit: 50 })).toBe('۴۹ گزارش باز');
  });

  it('says «دست‌کم» when the chat page came back full, because there is no total', () => {
    expect(queueCountWording({ kind: 'bounded', value: 50, limit: 50 })).toBe('دست‌کم ۵۰ گزارش باز');
  });

  it('says an empty queue the same way for both kinds', () => {
    expect(queueCountWording({ kind: 'exact', value: 0 })).toBe('صف خالی است');
    expect(queueCountWording({ kind: 'bounded', value: 0, limit: 50 })).toBe('صف خالی است');
  });
});

// =============================================================================
// Personas at /admin
// =============================================================================

describe('a full moderator at /admin', () => {
  it('gets the moderator landing, never the overview', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'صف‌های بررسی' })).toBeInTheDocument();
    await settled();
    expect(screen.queryByRole('heading', { name: 'نمای کلی' })).toBeNull();
    expect(screen.queryByText('پلتفرم در ۳۰ روز گذشته')).toBeNull();
  });

  it('labels the bar «بیوکلیک — بررسی محتوا» and offers only the landing and the four queues', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(within(bar()).getByText('بیوکلیک — بررسی محتوا')).toBeInTheDocument();
    expect(within(bar()).queryByText('بیوکلیک — مدیریت')).toBeNull();
    expect(navLinks()).toEqual([
      ['/admin', 'صف‌های بررسی'],
      ['/admin/verification', 'احراز هویت'],
      ['/admin/media', 'گزارش تصاویر'],
      ['/admin/reviews', 'بازبینی دیدگاه‌ها'],
      ['/admin/chat-reports', 'گزارش گفتگوها'],
    ]);
  });

  it('shows only its own moderation scopes — «مدیریت پلتفرم» never appears', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const scopes = within(screen.getByTestId('admin-scopes'));
    expect(scopes.getByText('بررسی احراز هویت')).toBeInTheDocument();
    expect(scopes.getByText('بررسی گفتگوها')).toBeInTheDocument();
    expect(scopes.queryByText('مدیریت پلتفرم')).toBeNull();
  });

  it('shows one card per queue, in the fixed order, each an h2 whose one link carries the count', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const items = landingCards();
    expect(items.map((li) => li.getAttribute('data-queue'))).toEqual(MODERATION_HREFS);

    const expected: Array<[string, string]> = [
      ['احراز هویت، ۳ مورد در صف', '/admin/verification'],
      ['گزارش تصاویر، ۱۲ مورد در صف', '/admin/media'],
      ['بازبینی دیدگاه‌ها، صف خالی است', '/admin/reviews'],
      ['گزارش گفتگوها، ۷ گزارش باز', '/admin/chat-reports'],
    ];
    items.forEach((li, i) => {
      const heading = within(li).getByRole('heading', { level: 2 });
      const links = within(li).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(heading).toContainElement(links[0]);
      expect(links[0]).toHaveAccessibleName(expected[i][0]);
      expect(links[0]).toHaveAttribute('href', expected[i][1]);
    });
  });

  it('reads nothing but the four queue counts — no platform read of any kind', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect([...new Set(adminCalls())].sort()).toEqual(Object.values(LANDING_READS).sort());
    // Specifically not the overview's reads.
    for (const platform of ['/v1/admin/analytics', '/v1/admin/phone-conflicts', '/v1/admin/notifications', '/v1/admin/search']) {
      expect(adminCalls().some((c) => c.startsWith(platform))).toBe(false);
    }
  });

  it('asks each paginated queue for one row, and the chat queue with its limit and no status', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(calls).toEqual(
      expect.arrayContaining([
        '/v1/admin/verification/queue?page=1&limit=1',
        '/v1/admin/media/reports?page=1&limit=1',
        '/v1/admin/reviews/queue?page=1&limit=1',
        `/v1/admin/chat/reports?limit=${CHAT_REPORT_COUNT_LIMIT}`,
      ]),
    );
  });

  it('keeps the empty queue a link, with the success treatment', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const reviews = landingCards()[2];
    expect(within(reviews).getByRole('link')).toHaveAttribute('href', '/admin/reviews');
    expect(within(reviews).getByText('صف خالی است')).toBeInTheDocument();
    expect(reviews.className).toContain('cardEmpty');
    expect(landingCards()[0].className).not.toContain('cardEmpty');
  });
});

describe('a full moderator opening a queue', () => {
  it.each([
    ['/admin/verification', () => <AdminVerificationPage />, '/v1/admin/verification/queue'],
    ['/admin/media', () => <AdminMediaPage />, '/v1/admin/media/reports'],
    ['/admin/reviews', () => <AdminReviewsPage />, '/v1/admin/reviews/queue'],
    ['/admin/chat-reports', () => <AdminChatReportsPage />, '/v1/admin/chat/reports'],
  ])('%s renders inside the shell and reads its own queue — the gap #264 closes', async (path, make, read) => {
    installApi(ALL_MODERATION, {
      '/v1/admin/verification/queue': () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }),
      '/v1/admin/media/reports': () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }),
      '/v1/admin/reviews/queue': () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }),
      '/v1/admin/chat/reports': () => ok({ items: [] }),
    });
    renderAt(path, make());
    await waitFor(() => expect(adminCalls()).toContain(read));
    await waitFor(() => expect(screen.queryByText(/در حال بارگذاری/)).toBeNull());
    expect(screen.queryByText(/دسترسی لازم برای این بخش را ندارد/)).toBeNull();
    expect(within(bar()).getByText('بیوکلیک — بررسی محتوا')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'ناوبری مدیریت' })).getByRole('link', { current: 'page' })).toHaveAttribute('href', path);
    // Its own queue, and no other admin read at all.
    expect([...new Set(adminCalls())]).toEqual([read]);
  });
});

describe('a partial moderator', () => {
  it('sees only the cards and the bar entries it holds, in the fixed order', async () => {
    installApi(['bc_moderate_chat', 'bc_moderate_media']);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(landingCards().map((li) => li.getAttribute('data-queue'))).toEqual(['/admin/media', '/admin/chat-reports']);
    expect(navLinks()).toEqual([
      ['/admin', 'صف‌های بررسی'],
      ['/admin/media', 'گزارش تصاویر'],
      ['/admin/chat-reports', 'گزارش گفتگوها'],
    ]);
    // No disabled card, no "you cannot see…" line for the two it lacks.
    expect(screen.queryByText(/احراز هویت/)).toBeNull();
    expect(screen.queryByText(/بازبینی دیدگاه‌ها/)).toBeNull();
    expect([...new Set(adminCalls())].sort()).toEqual(['/v1/admin/chat/reports', '/v1/admin/media/reports']);
  });

  it('is refused by the page guard when it types another queue’s URL', async () => {
    installApi(['bc_moderate_media']);
    renderAt('/admin/verification', <AdminVerificationPage />);
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(adminCalls()).toEqual([]);
  });
});

describe('a one-capability moderator', () => {
  it('gets a stable one-card landing and a two-entry bar — and is NOT redirected', async () => {
    installApi(['bc_moderate_reviews'], { '/v1/admin/reviews/queue': () => page(4) });
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(landingCards()).toHaveLength(1);
    expect(within(landingCards()[0]).getByRole('link')).toHaveAccessibleName('بازبینی دیدگاه‌ها، ۴ مورد در صف');
    expect(navLinks()).toEqual([
      ['/admin', 'صف‌های بررسی'],
      ['/admin/reviews', 'بازبینی دیدگاه‌ها'],
    ]);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('the administrator and the platform operator — unchanged', () => {
  it('gives the administrator the overview and exactly the bar it had before #264', async () => {
    installApi(ADMINISTRATOR, {
      '/v1/admin/verification/queue': () => page(3),
      '/v1/admin/phone-conflicts': () => page(0),
    });
    renderAt('/admin', <AdminIndexPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'نمای کلی' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('در انتظار بررسی شما')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'صف‌های بررسی' })).toBeNull();
    expect(within(bar()).getByText('بیوکلیک — مدیریت')).toBeInTheDocument();
    expect(within(bar()).queryByText('بیوکلیک — بررسی محتوا')).toBeNull();
    expect(navLinks()).toEqual(ADMINISTRATOR_NAV);
    expect(within(screen.getByTestId('admin-scopes')).getByText('مدیریت پلتفرم')).toBeInTheDocument();
  });

  it('gives the platform operator the overview and its filtered bar — no queues, no commercial', async () => {
    installApi(OPERATOR);
    renderAt('/admin', <AdminIndexPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'نمای کلی' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('در انتظار بررسی شما')).toBeInTheDocument());
    expect(navLinks()).toEqual(OPERATOR_NAV);
    expect(within(bar()).getByText('بیوکلیک — مدیریت')).toBeInTheDocument();
  });

  it.each([
    ['/admin/users', AdminUsersPage],
    ['/admin/audit-log', AdminAuditLogPage],
    ['/admin/phone-conflicts', AdminPhoneConflictsPage],
  ])('still renders %s for the operator, through its new page guard', async (path, Page) => {
    installApi(OPERATOR, {
      '/v1/admin/users/roles/catalogue': () => ok({ roles: [], capabilities: [] }),
      '/v1/admin/audit-log/actions': () => ok([]),
      '/v1/admin/audit-log': () => ok([], { pagination: { page: 1, limit: 25, total: 0 } }),
      '/v1/admin/phone-conflicts': () => ok([], { pagination: { page: 1, limit: 25, total: 0 } }),
    });
    renderAt(path, <Page />);
    await waitFor(() => expect(adminCalls().length).toBeGreaterThan(0));
    expect(screen.queryByText(/دسترسی لازم برای این بخش را ندارد/)).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 }).length).toBeGreaterThan(0));
  });
});

describe('a caller with no admin capability', () => {
  it.each([
    ['customer', ['bc_book_service', 'bc_use_chat']],
    ['commercial without platform', ['bc_manage_commercial_plans']],
    ['nothing', []],
  ])('%s gets the existing no-access state, no shell and no landing', async (_name, capabilities) => {
    installApi(capabilities);
    renderAt('/admin', <AdminIndexPage />);
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-bar')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'صف‌های بررسی' })).toBeNull();
    expect(adminCalls()).toEqual([]);
  });
});

// =============================================================================
// Typed URLs a moderator must never render
// =============================================================================

const PLATFORM_PAGES: Array<[string, () => React.ReactElement]> = [
  ['/admin/users', () => <AdminUsersPage />],
  ['/admin/audit-log', () => <AdminAuditLogPage />],
  ['/admin/settlements', () => <AdminSettlementsPage />],
  ['/admin/privacy', () => <AdminPrivacyPage />],
  ['/admin/search', () => <AdminSearchPage />],
  ['/admin/notifications', () => <AdminNotificationsPage />],
  ['/admin/phone-conflicts', () => <AdminPhoneConflictsPage />],
  ['/admin/loyalty', () => <AdminLoyaltyPage />],
  ['/admin/commercial/plans', () => <AdminPlansPage />],
  ['/admin/commercial/commission-policies', () => <AdminCommissionPoliciesPage />],
  ['/admin/commercial/outcome-policy', () => <AdminOutcomePolicyPage />],
  ['/admin/commercial/control-plane', () => <AdminControlPlanePage />],
];

describe('a full moderator typing a platform or commercial URL', () => {
  it.each(PLATFORM_PAGES)('%s: the shell refuses it before the page mounts or asks the API', async (path, make) => {
    installApi(ALL_MODERATION);
    renderAt(path, make());
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    // The moderator keeps their own bar — and their own bar only.
    expect(within(bar()).getByText('بیوکلیک — بررسی محتوا')).toBeInTheDocument();
    expect(navLinks().map(([href]) => href)).toEqual(['/admin', ...MODERATION_HREFS]);
    expect(adminCalls()).toEqual([]);
  });

  // The shell's layer on its own: a page that FORGOT its guard — the exact
  // state eight pages were in before #264 — is still never rendered for a
  // moderator. Without this case the page guards above would hide a broken
  // route gate.
  it.each(['/admin/users', '/admin/settlements', '/admin/commercial/some-future-page', '/admin/anything-new'])(
    '%s: the shell refuses even a page with no guard of its own',
    async (path) => {
      installApi(ALL_MODERATION);
      renderAt(path, <p>محتوای بدون نگهبان</p>);
      expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
      expect(screen.queryByText('محتوای بدون نگهبان')).toBeNull();
      expect(within(bar()).getByText('بیوکلیک — بررسی محتوا')).toBeInTheDocument();
    },
  );

  it('the shell’s route gate changes nothing for the administrator', async () => {
    installApi(ADMINISTRATOR);
    renderAt('/admin/anything-new', <p>محتوای بدون نگهبان</p>);
    expect(await screen.findByText('محتوای بدون نگهبان')).toBeInTheDocument();
  });

  // The second, independent layer: the page's own guard, with no layout at all.
  // Proves each page states its authority itself rather than relying on the
  // shell — the exact assumption that made #264 dangerous to fix naively.
  it.each(PLATFORM_PAGES)('%s: the page’s own guard refuses it too, without the layout', async (_path, make) => {
    installApi(ALL_MODERATION);
    renderAt(_path, make(), false);
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(adminCalls()).toEqual([]);
  });
});

// =============================================================================
// Card states — each card independent
// =============================================================================

describe('a card', () => {
  it('is aria-busy with a skeleton until its own count arrives', async () => {
    let release: (reply: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    installApi(ALL_MODERATION);
    // One queue held back; the others answer at once.
    const original = (global.fetch as jest.Mock).getMockImplementation()!;
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/v1/admin/media/reports')) {
        calls.push('/v1/admin/media/reports');
        const reply = await pending;
        if (reply === 'network') throw new TypeError('Failed to fetch');
        return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
      }
      return original(url, init);
    });

    renderAt('/admin', <AdminIndexPage />);
    await waitFor(() => expect(document.querySelector('[data-queue="/admin/verification"]')).toHaveAttribute('data-state', 'ready'));
    const media = document.querySelector('[data-queue="/admin/media"]') as HTMLElement;
    expect(media).toHaveAttribute('aria-busy', 'true');
    expect(media).toHaveAttribute('data-state', 'loading');
    // Loading says no number: the link's name is the destination alone.
    expect(within(media).getByRole('link')).toHaveAccessibleName('گزارش تصاویر');

    await act(async () => release(page(5)));
    await waitFor(() => expect(media).toHaveAttribute('data-state', 'ready'));
    expect(media).not.toHaveAttribute('aria-busy');
    expect(within(media).getByRole('link')).toHaveAccessibleName('گزارش تصاویر، ۵ مورد در صف');
  });

  it('fails alone, with role="alert" and a retry that re-asks only its own queue', async () => {
    let failing = true;
    installApi(ALL_MODERATION, {
      '/v1/admin/verification/queue': () => (failing ? 'network' : page(9)),
    });
    renderAt('/admin', <AdminIndexPage />);
    await settled();

    const [verification, media, reviews, chat] = landingCards();
    expect(verification).toHaveAttribute('data-state', 'error');
    expect(within(verification).getByRole('alert')).toHaveTextContent('تعداد این صف خوانده نشد.');
    // No guessed number, and the link still goes to the queue.
    expect(within(verification).getByRole('link')).toHaveAccessibleName('احراز هویت');
    for (const other of [media, reviews, chat]) {
      expect(other).toHaveAttribute('data-state', 'ready');
      expect(within(other).queryByRole('alert')).toBeNull();
      expect(within(other).queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    }

    const before = { ...countBy(adminCalls()) };
    failing = false;
    await userEvent.click(within(verification).getByRole('button', { name: 'تلاش دوباره' }));
    await waitFor(() => expect(verification).toHaveAttribute('data-state', 'ready'));
    expect(within(verification).getByRole('link')).toHaveAccessibleName('احراز هویت، ۹ مورد در صف');
    const after = countBy(adminCalls());
    expect(after['/v1/admin/verification/queue']).toBe((before['/v1/admin/verification/queue'] ?? 0) + 1);
    for (const other of ['/v1/admin/media/reports', '/v1/admin/reviews/queue', '/v1/admin/chat/reports']) {
      expect(after[other]).toBe(before[other]);
    }
  });

  it('treats a response without a total as a failed read, never as zero', async () => {
    installApi(ALL_MODERATION, { '/v1/admin/media/reports': () => ok([], null) });
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const media = landingCards()[1];
    expect(media).toHaveAttribute('data-state', 'error');
    expect(within(media).queryByText('صف خالی است')).toBeNull();
  });
});

describe('the chat card — its route has no total', () => {
  const chatWith = (n: number) => ({
    '/v1/admin/chat/reports': () => ok({ items: Array.from({ length: n }, (_, i) => ({ id: `r${i}` })) }),
  });

  it.each([
    [0, 'گزارش گفتگوها، صف خالی است'],
    [1, 'گزارش گفتگوها، ۱ گزارش باز'],
    [CHAT_REPORT_COUNT_LIMIT - 1, 'گزارش گفتگوها، ۴۹ گزارش باز'],
    [CHAT_REPORT_COUNT_LIMIT, 'گزارش گفتگوها، دست‌کم ۵۰ گزارش باز'],
  ])('%i reports → «%s»', async (n, name) => {
    installApi(['bc_moderate_chat'], chatWith(n));
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(within(landingCards()[0]).getByRole('link')).toHaveAccessibleName(name);
  });
});

// =============================================================================
// Live revocation
// =============================================================================

describe('revocation, live', () => {
  it('re-reads /v1/me on entry to /admin and on every navigation inside it', async () => {
    installApi(ALL_MODERATION);
    const view = renderAt('/admin', <AdminIndexPage />);
    await settled();
    await waitFor(() => expect(meReads()).toBe(2)); // the session restore, then entry
    mockPathname = '/admin/reviews';
    view.rerender(tree(<AdminReviewsPage />));
    await waitFor(() => expect(meReads()).toBe(3));
  });

  it('drops a revoked queue from the bar at the next navigation', async () => {
    installApi(ALL_MODERATION);
    const view = renderAt('/admin', <AdminIndexPage />);
    await settled();
    caps = ['bc_moderate_verification', 'bc_moderate_chat'];
    mockPathname = '/admin/verification';
    view.rerender(tree(<AdminVerificationPage />));
    await waitFor(() =>
      expect(navLinks().map(([href]) => href)).toEqual(['/admin', '/admin/verification', '/admin/chat-reports']),
    );
  });

  it('turns a card refused with 403 into the revoked sentence — no retry, no stale count — and re-reads /v1/me', async () => {
    installApi(ALL_MODERATION, { '/v1/admin/media/reports': forbidden });
    // The server still says "media" until the re-read; hold the re-read so the
    // intermediate state can be seen.
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const media = landingCards()[1];
    expect(media).toHaveAttribute('data-state', 'revoked');
    expect(within(media).getByText('دسترسی شما به این صف تغییر کرده است.')).toBeInTheDocument();
    expect(within(media).queryByRole('button')).toBeNull();
    expect(within(media).queryByRole('link')).toBeNull();
    expect(within(media).queryByText(/مورد در صف/)).toBeNull();
    // Entry read + the card's own re-read after the 403 (the transport's
    // re-read is single-flighted with it).
    await waitFor(() => expect(meReads()).toBeGreaterThanOrEqual(3));
  });

  it('removes the revoked card once /v1/me no longer lists the capability', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(landingCards()).toHaveLength(4);

    // Revoked on the server: /v1/me drops it and the route refuses.
    caps = ['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_chat'];
    routes['/v1/admin/media/reports'] = forbidden;
    await reReadMe();

    await waitFor(() => expect(landingCards()).toHaveLength(3));
    expect(landingCards().map((li) => li.getAttribute('data-queue'))).toEqual([
      '/admin/verification',
      '/admin/reviews',
      '/admin/chat-reports',
    ]);
    expect(navLinks().map(([href]) => href)).not.toContain('/admin/media');
    // The others kept their counts: nothing re-fetched that did not need to.
    expect(within(landingCards()[0]).getByRole('link')).toHaveAccessibleName('احراز هویت، ۳ مورد در صف');
  });

  it('re-reads /v1/me after ANY 403 from an admin route, so the card goes without a manual step', async () => {
    installApi(ALL_MODERATION);
    // /v1/me already says media is gone; the landing started before the change.
    const view = renderAt('/admin', <AdminIndexPage />);
    await settled();
    caps = ['bc_moderate_verification'];
    routes['/v1/admin/media/reports'] = forbidden;
    // Force the media card to re-ask: unmount and remount the landing.
    view.rerender(tree(<p>elsewhere</p>));
    view.rerender(tree(<AdminIndexPage />));
    await waitFor(() => expect(landingCards().map((li) => li.getAttribute('data-queue'))).toEqual(['/admin/verification']));
  });

  it('shows the existing no-access state, not an empty landing, when the last moderation capability goes', async () => {
    installApi(['bc_moderate_chat']);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(landingCards()).toHaveLength(1);

    caps = [];
    await reReadMe();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'صف‌های بررسی' })).toBeNull();
    expect(screen.queryByTestId('admin-bar')).toBeNull();
  });

  it('clears an open queue page whose capability is revoked, with one sentence and «بازگشت» to the landing', async () => {
    installApi(['bc_moderate_media', 'bc_moderate_chat'], {
      '/v1/admin/media/reports': () =>
        ok(
          [{ id: 'm1', mediaObjectId: 'o1', reason: 'inappropriate', note: 'یادداشت گزارش‌دهنده', status: 'open', createdAt: '2026-09-20T10:00:00.000Z' }],
          { pagination: { page: 1, limit: 20, total: 1 } },
        ),
    });
    renderAt('/admin/media', <AdminMediaPage />);
    await waitFor(() => expect(adminCalls()).toContain('/v1/admin/media/reports'));
    await waitFor(() => expect(screen.queryByText(/در حال بارگذاری/)).toBeNull());
    const before = document.body.textContent ?? '';
    expect(before).toContain('یادداشت گزارش‌دهنده');

    caps = ['bc_moderate_chat'];
    await reReadMe();

    expect(await screen.findByText('دسترسی شما به این بخش تغییر کرده است.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'بازگشت' })).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
    expect(document.body.textContent).not.toContain('یادداشت گزارش‌دهنده');
    // And the bar no longer offers it.
    expect(navLinks().map(([href]) => href)).toEqual(['/admin', '/admin/chat-reports']);
  });

  it('keeps the plain no-access wording for a page whose capability was never held', async () => {
    installApi(['bc_moderate_chat']);
    renderAt('/admin/reviews', <AdminReviewsPage />);
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(screen.queryByText('دسترسی شما به این بخش تغییر کرده است.')).toBeNull();
  });

  it('does not re-render consumers when a re-read changed nothing', async () => {
    installApi(['bc_moderate_chat']);
    let renders = 0;
    function Counter() {
      const { user } = useAuth();
      renders += user ? 1 : 0;
      return null;
    }
    render(
      <AuthProvider>
        <ReloadProbe />
        <Counter />
      </AuthProvider>,
    );
    await waitFor(() => expect(renders).toBeGreaterThan(0));
    const settledRenders = renders;
    await reReadMe();
    await act(async () => undefined);
    expect(renders).toBe(settledRenders);
  });

  it('keeps the current user when a re-read fails, rather than signing anybody out', async () => {
    installApi(['bc_moderate_chat']);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const original = (global.fetch as jest.Mock).getMockImplementation()!;
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (/\/v1\/me$/.test(new URL(String(url)).pathname)) {
        calls.push('/v1/me');
        throw new TypeError('Failed to fetch');
      }
      return original(url, init);
    });
    await reReadMe();
    expect(landingCards()).toHaveLength(1);
    expect(screen.getByTestId('admin-bar')).toBeInTheDocument();
  });
});

describe('the transport’s own re-read after a 403', () => {
  function Caller({ path }: { path: string }) {
    const { api, status } = useAuth();
    return (
      <button type="button" disabled={status !== 'authenticated'} onClick={() => void api.get(path).catch(() => undefined)}>
        call
      </button>
    );
  }

  async function callAndCount(path: string): Promise<number> {
    render(
      <AuthProvider>
        <Caller path={path} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'call' })).toBeEnabled());
    const before = meReads();
    await userEvent.click(screen.getByRole('button', { name: 'call' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith(path.split('?')[0]))).toBe(true));
    // Give a re-read, if any, the chance to go out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return meReads() - before;
  }

  it('re-reads /v1/me when an ADMIN route answers 403, with no component asking', async () => {
    installApi(['bc_moderate_chat'], { '/v1/admin/audit-log': forbidden });
    expect(await callAndCount('/v1/admin/audit-log')).toBe(1);
  });

  it('does not re-read for a 403 outside /v1/admin — that is an ownership refusal, not a revocation', async () => {
    installApi(['bc_book_service'], { '/v1/bookings/b1': forbidden });
    expect(await callAndCount('/v1/bookings/b1')).toBe(0);
  });
});

describe('AdminGuard on its own', () => {
  it('distinguishes "revoked while here" from "never held"', async () => {
    installApi(['bc_moderate_reviews']);
    render(
      <AuthProvider>
        <ReloadProbe />
        <AdminGuard capability="bc_moderate_reviews">
          <p>محتوای صف</p>
        </AdminGuard>
      </AuthProvider>,
    );
    expect(await screen.findByText('محتوای صف')).toBeInTheDocument();
    caps = [];
    await reReadMe();
    expect(await screen.findByText('دسترسی شما به این بخش تغییر کرده است.')).toBeInTheDocument();
    expect(screen.queryByText('محتوای صف')).toBeNull();
  });
});

// =============================================================================
// Keyboard, RTL and responsive
// =============================================================================

describe('keyboard and structure', () => {
  it('reaches every card link by Tab, in the fixed order, after the bar', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    const cardLinks = landingCards().map((li) => within(li).getByRole('link'));
    const order: HTMLElement[] = [];
    for (let i = 0; i < 30 && order.length < cardLinks.length; i += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement;
      if (cardLinks.includes(active)) order.push(active);
    }
    expect(order).toEqual(cardLinks);
  });

  it('is one h1 and one list of cards, each titled by an h2', async () => {
    installApi(ALL_MODERATION);
    renderAt('/admin', <AdminIndexPage />);
    await settled();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(landingList().tagName).toBe('UL');
    expect(within(landingList()).getAllByRole('heading', { level: 2 })).toHaveLength(4);
  });
});

describe('the landing stylesheet', () => {
  const css = readFileSync(join(__dirname, '../components/moderator-landing.module.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('lays the cards out as spec 52 §6 gives it: auto-fit, 240px minimum', () => {
    expect(rules).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(240px,\s*1fr\)\)/);
  });

  it('stacks at 390 by arithmetic, not by a breakpoint: two minimums do not fit', () => {
    // 390 wide, 16px gutter each side. Two columns would need 2 × 240 plus a gap.
    expect(390 - 2 * 16).toBeLessThan(2 * 240);
    // And four fit at 1280 with the admin gutter.
    expect(1280 - 2 * 32).toBeGreaterThan(4 * 240 + 3 * 16);
    expect(rules).not.toMatch(/@media/);
  });

  it('uses logical properties only, so RTL needs nothing of its own', () => {
    expect(rules).not.toMatch(/(^|[\s;{])(margin|padding|border)-(left|right)\s*:/m);
    expect(rules).not.toMatch(/(^|[\s;{])(left|right)\s*:/m);
    expect(rules).not.toMatch(/text-align:\s*(left|right)/);
  });
});

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
