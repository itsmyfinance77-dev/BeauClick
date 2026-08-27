'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { useUnread } from '@/lib/unread-context';
import { ErrorBoundary } from './error-boundary';

/**
 * The application shell: header + main region, wrapped in an error
 * boundary. Deliberately minimal -- this is the foundation future phases
 * mount real product surfaces into, not a finished chrome.
 *
 * Responsive baseline: a single fluid column bounded by the design
 * system's own content-max-width token, with section padding that steps up
 * at the token-defined breakpoint (see the clamp below). Mobile-first --
 * the base rules ARE the mobile rules.
 */
/**
 * Header nav links get a real 44px touch target.
 *
 * They were 25px tall, which is comfortably tappable for a mouse and
 * genuinely awkward on a phone -- and below the 44px baseline this project's
 * own frontend foundation set for itself. Measured directly in a 375px
 * viewport during Phase 2 live QA rather than eyeballed.
 */
const NAV_LINK_STYLE = {
  fontSize: 14,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  // Vertical padding only: horizontal padding here would push the nav wide
  // enough to wrap at 375px.
  padding: '0 2px',
} as const;

/**
 * One nav destination, marked as the current page when it is.
 *
 * The nav previously gave no indication of where the user was -- every link
 * rendered identically on every page. `aria-current="page"` is the part a
 * screen reader needs; the weight/colour change is the part everyone else
 * needs, since colour alone is not a distinction every reader can make.
 */
function NavLink({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) {
  const pathname = usePathname();
  // Exact match only: '/' would otherwise prefix-match every route.
  const isCurrent = pathname === href;
  return (
    <Link
      href={href}
      aria-current={isCurrent ? 'page' : undefined}
      style={{
        ...NAV_LINK_STYLE,
        fontWeight: isCurrent ? 800 : NAV_LINK_STYLE.fontWeight,
        color: isCurrent ? 'var(--bc-color-primary)' : undefined,
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { status, user, logout } = useAuth();
  // Shared with the notification centre, so marking everything read updates
  // the badge immediately rather than at the next full page load.
  const { unreadCount: unread } = useUnread();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          borderBlockEnd: '1px solid var(--bc-color-line)',
          background: 'var(--bc-color-surface)',
        }}
      >
        <div
          style={{
            maxWidth: 'var(--bc-spacing-content-max-width)',
            margin: '0 auto',
            padding: 'clamp(12px, 2vw, 16px) clamp(var(--bc-spacing-section-mobile), 4vw, var(--bc-spacing-section-desktop))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--bc-spacing-card-gap)',
            // The header must be allowed to wrap onto a second line.
            // Phase 3 added four nav destinations (search, journey, loyalty,
            // notifications) to a bar that was already near capacity, and a
            // signed-in nav measured 606px against a 375px viewport -- real
            // horizontal overflow, and a regression against the no-overflow
            // property Phase 2 verified. It went unnoticed at first because
            // the earlier measurement was taken SIGNED OUT, where the nav
            // holds three links instead of seven.
            flexWrap: 'wrap',
          }}
        >
          <Link
            href="/"
            style={{
              fontWeight: 800,
              fontSize: 20,
              textDecoration: 'none',
              color: 'var(--bc-color-ink)',
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
            }}
          >
            BeauClick
          </Link>

          <nav
            aria-label="ناوبری اصلی"
            style={{
              display: 'flex',
              alignItems: 'center',
              // Wrap rather than overflow, and use the smaller chip gap: seven
              // destinations at the large gap do not fit a phone even wrapped.
              flexWrap: 'wrap',
              gap: 'var(--bc-spacing-chip-gap)',
              rowGap: 4,
              justifyContent: 'flex-end',
              // Never force the header wider than its container.
              minWidth: 0,
            }}
          >
            <NavLink href="/search">
              جست‌وجو
            </NavLink>
            <NavLink href="/providers">
              متخصص‌ها
            </NavLink>
            {status === 'authenticated' ? (
              <>
                <NavLink href="/bookings">
                  رزروهای من
                </NavLink>
                <NavLink href="/journey">
                  مسیر من
                </NavLink>
                <NavLink href="/loyalty">
                  باشگاه
                </NavLink>
                <NavLink href="/waitlist">
                  لیست انتظار
                </NavLink>
                <NavLink href="/business">
                  کسب‌وکار
                </NavLink>
                {/*
                  Shown to every authenticated user, and that is deliberate
                  rather than an oversight: becoming a professional in V3 is
                  self-service (`POST /v1/providers`, any session), so this is
                  the entry point to a mode anyone may enter, not a link to
                  something only some users have. `/pro` itself distinguishes
                  "you have no professional profile" from "the request failed"
                  and offers to create one.

                  It is NOT the same situation as QA-25's business link, which
                  is shown to everyone because no signal exists to condition it
                  on. Here no condition is wanted.
                */}
                <NavLink href="/pro">
                  حالت متخصص
                </NavLink>
                {/*
                  Shown ONLY to a session that actually holds the platform
                  capability -- unlike the two links above, which are entry
                  points to modes anyone may enter.

                  The capability list on `user` is resolved LIVE by `/v1/me`
                  from `identity.user_roles`, not echoed from the token, so a
                  revoked operator loses the link at the next page load rather
                  than at the next token. And hiding it is a courtesy, never the
                  control: `CapabilityGuard` refuses the request regardless of
                  what the nav shows.
                */}
                {user?.capabilities?.includes('bc_manage_platform') ? (
                  <NavLink href="/admin">
                    مدیریت
                  </NavLink>
                ) : null}
                <NavLink
                  href="/notifications"
                  // The count is in the accessible name, so a screen reader
                  // announces "اعلان‌ها، ۳ خوانده‌نشده" rather than reading a
                  // bare number next to a link.
                  aria-label={unread > 0 ? `اعلان‌ها، ${toPersianDigits(unread)} خوانده‌نشده` : 'اعلان‌ها'}
                >
                  اعلان‌ها
                  {unread > 0 && (
                    <span
                      aria-hidden="true"
                      style={{
                        marginInlineStart: 4,
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '1px 7px',
                        borderRadius: 999,
                        background: 'var(--bc-color-primary)',
                        color: 'var(--bc-color-surface)',
                      }}
                    >
                      {toPersianDigits(unread)}
                    </span>
                  )}
                </NavLink>
                <NavLink href="/dashboard">
                  داشبورد
                </NavLink>
                <span style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>{user?.displayName ?? user?.phone}</span>
                <button
                  type="button"
                  onClick={() => void logout()}
                  style={{
                    font: 'inherit',
                    fontSize: 14,
                    padding: '8px 14px',
                    borderRadius: 'var(--bc-radius-button)',
                    border: '1px solid var(--bc-color-line)',
                    background: 'transparent',
                    color: 'var(--bc-color-ink)',
                    cursor: 'pointer',
                    // 44, not 40. Measured at 43px in a real browser during
                    // Phase 3 live QA -- a hair under the touch baseline this
                    // project set for itself, and the same class of finding as
                    // Phase 2's 25px nav links.
                    minHeight: 44,
                  }}
                >
                  خروج
                </button>
              </>
            ) : (
              <NavLink href="/auth">
                ورود
              </NavLink>
            )}
          </nav>
        </div>
      </header>

      <main
        id="main"
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 'var(--bc-spacing-content-max-width)',
          margin: '0 auto',
          padding: 'clamp(var(--bc-spacing-section-mobile), 4vw, var(--bc-spacing-section-desktop))',
        }}
      >
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
