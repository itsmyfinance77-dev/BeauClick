'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { useUnread } from '@/lib/unread-context';
import { ErrorBoundary } from './error-boundary';
import { AvatarMenu, type AvatarMenuEntry } from './avatar-menu';
import { MobileTabBar } from './mobile-tab-bar';
import { SiteFooter } from './site-footer';
import styles from './app-shell.module.css';

/**
 * The customer shell — `V3_INFORMATION_ARCHITECTURE.md` §1–§2, and the header
 * of every artboard in `Prototype - Customer.dc.html`.
 *
 * ## What changed, and why it is not a cosmetic change
 *
 * The signed-in header carried ELEVEN equally weighted destinations. The
 * information-architecture document measured that bar at about 606px at 1280
 * and recorded three faults: two roles in one bar (professional mode and the
 * business are seller destinations, not customer ones), four destinations for
 * one idea (bookings, journey, loyalty and dashboard are all "my history with
 * this product"), and no hierarchy at all — «خروج» sat at the same weight as
 * «جست‌وجو».
 *
 * Three levels replace it. The header keeps what a customer uses weekly; the
 * avatar menu holds what they use occasionally; and below 640px a
 * five-destination bottom bar replaces header navigation entirely, because
 * mobile is not a narrowed desktop.
 *
 * ## One deviation from the design, deliberate
 *
 *  1. **«خدمات» points at `/search`.** The design's first destination is
 *     `/services`, a specialty index it marks «جدید — نما». That route does
 *     not exist, and a header link to a 404 is worse than one to the surface
 *     that answers the same question today. Recorded as a gap; the link moves
 *     when the route lands.
 *
 * The journey and loyalty links stay in the avatar menu, which the design does
 * not list there. That is no longer a deviation waiting on an unbuilt
 * dashboard — `/dashboard` exists and links to both — but removing a live
 * destination from the menu is a navigation change of its own rather than part
 * of this conformance pass.
 *
 * ## The footer is not global
 *
 * Only the home artboard carries one; search, the profile and the dashboard
 * do not. So it renders on `/` and on the four pages it links to
 * (`33_FOOTER_LEGAL.md` puts the site footer on each of them), rather than
 * being assumed to be site chrome.
 */

/** The routes that carry the footer. The legal pages are content pages that render inside the contained main, like any other. */
const FOOTER_ROUTES = new Set(['/', '/terms', '/privacy-policy', '/contact', '/support']);

/**
 * Route groups with their own nav chrome, and so never the customer's bottom
 * bar -- `25_MOBILE_NAVIGATION.md`'s own table. `/admin` gets a dark
 * horizontal scrolling bar instead of any bottom bar at all (`AdminShell`);
 * `/pro` is meant to get its own two-tab bar plus a sheet for the rest,
 * which is not built yet, but the customer's five destinations (home,
 * search, bookings, loyalty, account) are still the wrong ones to show over
 * either shell in the meantime.
 */
const NO_TAB_BAR_PREFIXES = ['/admin', '/pro'];

/** `/` matches only itself; every other destination also owns its subtree. */
function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** True for `/admin`, `/admin/x`, `/pro`, `/pro/x` -- never for a route that merely starts with the same letters, e.g. `/products`. */
function hidesTabBar(pathname: string): boolean {
  return NO_TAB_BAR_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, user, logout } = useAuth();
  // Shared with the notification centre, so marking everything read updates
  // the badge immediately rather than at the next full page load.
  const { unreadCount: unread } = useUnread();
  const pathname = usePathname() ?? '/';

  const authenticated = status === 'authenticated';
  const isHome = pathname === '/';

  /**
   * A seller, resolved from the session's LIVE roles.
   *
   * `professional` is granted in the same transaction as the profile row
   * (`ProviderService.create`, V3.3 #75) and the existing owners were
   * backfilled (`20260905800001_backfill_seller_owner_roles.sql`), so the role
   * answers "does this person own a professional profile?" exactly. `/v1/me`
   * resolves it from `identity.user_roles` on every load rather than echoing
   * the token, so a revocation takes the entry away at the next page load.
   *
   * The information architecture asks for `bc_provider`; no such capability
   * exists, and `professional` is the role that vocabulary means.
   */
  const isSeller = user?.roles?.includes('professional') ?? false;

  const primary = [
    { href: '/search', label: 'خدمات' },
    { href: '/providers', label: 'متخصص‌ها' },
    // `V3_INFORMATION_ARCHITECTURE.md` §2's third level-one destination is the
    // umbrella page, not the bookings list: `/dashboard` gathers bookings, the
    // journey, loyalty and notifications, and spec 03 calls it «صفحهٔ مادرِ
    // حساب من». `/bookings` keeps its own full page and the dashboard links to
    // it, so nothing breaks — this only changes which one the header names.
    ...(authenticated ? [{ href: '/dashboard', label: 'حساب من' }] : []),
  ];

  /*
    Everything a customer reaches occasionally. `/finance` is here for every
    authenticated session and not conditioned on a role, for the reason
    Story #152 gives: a finance-only staff member has no professional profile
    and no business ownership, so any condition would hide the one destination
    that is theirs. `/admin` is the exception — it is shown only to a session
    that actually holds the capability, resolved live by `/v1/me` rather than
    echoed from the token, and hiding it is a courtesy while `CapabilityGuard`
    remains the control.

    «حالت متخصص» is now the same kind of exception: §2's level three shows it
    only to a user who actually owns a professional profile. It was offered to
    every signed-in customer, and a customer who took it reached `ProGuard`'s
    "you have no profile yet" state — an invitation to a dead end.

    `/dashboard` is no longer here: it is a level-one destination now, and the
    same link twice in one header is a menu entry that teaches nothing.
  */
  const menuEntries: AvatarMenuEntry[] = authenticated
    ? [
        { href: '/journey', label: 'مسیر من' },
        { href: '/loyalty', label: 'باشگاه' },
        { href: '/waitlist', label: 'لیست انتظار' },
        { href: '/finance', label: 'امور مالی' },
        { href: '/business', label: 'کسب‌وکار من' },
        ...(isSeller ? [{ href: '/pro', label: 'حالت متخصص' }] : []),
        ...(user?.capabilities?.includes('bc_manage_platform') ? [{ href: '/admin', label: 'مدیریت' }] : []),
      ]
    : [];

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand}>
            {/* A static brand mark from `public/`. `next/image` does not
                optimise SVG, so it would add a wrapper and no benefit. */}
            <img src="/brand/icon-circle.svg" alt="" width={26} height={26} className={styles.brandMark} />
            <span className={styles.brandName}>BeauClick</span>
          </Link>

          <nav aria-label="ناوبری اصلی" className={styles.primaryNav}>
            {primary.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={styles.primaryLink}
                aria-current={isCurrent(pathname, link.href) ? 'page' : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className={styles.headerEnd}>
            {authenticated ? (
              <>
                {isSeller ? (
                  <Link href="/pro" className={styles.proMode}>
                    حالت متخصص
                  </Link>
                ) : null}
                <Link
                  href="/notifications"
                  className={styles.bell}
                  // The count is in the accessible name, so a screen reader
                  // announces "اعلان‌ها، ۳ خوانده‌نشده" rather than reading a
                  // bare number beside a link.
                  aria-label={unread > 0 ? `اعلان‌ها، ${toPersianDigits(unread)} خوانده‌نشده` : 'اعلان‌ها'}
                  aria-current={isCurrent(pathname, '/notifications') ? 'page' : undefined}
                >
                  <span className={styles.bellGlyph} aria-hidden="true" />
                  {unread > 0 ? (
                    <span className={styles.bellCount} aria-hidden="true">
                      {toPersianDigits(unread)}
                    </span>
                  ) : null}
                </Link>
                <AvatarMenu
                  displayName={user?.displayName ?? 'حساب من'}
                  identity={user?.phone ?? null}
                  entries={menuEntries}
                  onSignOut={() => void logout()}
                />
              </>
            ) : (
              <Link href="/auth" className={styles.primaryLink} style={{ fontWeight: 600 }}>
                ورود
              </Link>
            )}
          </div>
        </div>
      </header>

      <main
        id="main"
        className={`${styles.main} ${isHome ? '' : styles.mainContained} ${hidesTabBar(pathname) ? '' : styles.mainBottomBarGap}`}
      >
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>

      {FOOTER_ROUTES.has(pathname) ? <SiteFooter /> : null}

      {hidesTabBar(pathname) ? null : <MobileTabBar />}
    </div>
  );
}
