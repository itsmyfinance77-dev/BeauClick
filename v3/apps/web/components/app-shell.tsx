'use client';

import Link from 'next/link';
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
            <Link href="/search" style={NAV_LINK_STYLE}>
              جست‌وجو
            </Link>
            <Link href="/providers" style={NAV_LINK_STYLE}>
              متخصص‌ها
            </Link>
            {status === 'authenticated' ? (
              <>
                <Link href="/bookings" style={NAV_LINK_STYLE}>
                  رزروهای من
                </Link>
                <Link href="/journey" style={NAV_LINK_STYLE}>
                  مسیر من
                </Link>
                <Link href="/loyalty" style={NAV_LINK_STYLE}>
                  باشگاه
                </Link>
                <Link
                  href="/notifications"
                  style={NAV_LINK_STYLE}
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
                </Link>
                <Link href="/dashboard" style={NAV_LINK_STYLE}>
                  داشبورد
                </Link>
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
              <Link href="/auth" style={NAV_LINK_STYLE}>
                ورود
              </Link>
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
