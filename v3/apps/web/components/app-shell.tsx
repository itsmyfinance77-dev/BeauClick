'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
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

          <nav aria-label="ناوبری اصلی" style={{ display: 'flex', alignItems: 'center', gap: 'var(--bc-spacing-chip-gap-large)' }}>
            <Link href="/providers" style={NAV_LINK_STYLE}>
              متخصص‌ها
            </Link>
            {status === 'authenticated' ? (
              <>
                <Link href="/bookings" style={NAV_LINK_STYLE}>
                  رزروهای من
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
                    minHeight: 40,
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
