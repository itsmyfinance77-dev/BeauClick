'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './app-shell.module.css';

/**
 * The five-destination bottom bar — `25_MOBILE_NAVIGATION.md` and
 * `V3_INFORMATION_ARCHITECTURE.md` §2.
 *
 * Mobile is not a narrowed desktop. Seven header links became five
 * destinations chosen on one rule: things a customer does several times a
 * month. Professional mode, the business, and the waitlist are not that, and
 * live under «حساب».
 *
 * Only shown below 640px — the stylesheet, not this component, decides that,
 * so there is no viewport guess in JavaScript and no hydration mismatch.
 *
 * Each tab carries a distinct glyph SHAPE as well as its colour: the current
 * destination must be identifiable without relying on colour.
 */

const TABS = [
  { href: '/', label: 'خانه', glyph: styles.tabGlyphHome },
  { href: '/search', label: 'جست‌وجو', glyph: styles.tabGlyphSearch },
  { href: '/bookings', label: 'رزروها', glyph: styles.tabGlyphBookings },
  { href: '/loyalty', label: 'باشگاه', glyph: styles.tabGlyphLoyalty },
  { href: '/dashboard', label: 'حساب', glyph: styles.tabGlyphAccount },
] as const;

/** `/` matches only itself; every other destination also owns its subtree. */
function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileTabBar() {
  const pathname = usePathname() ?? '/';

  return (
    <nav aria-label="ناوبری موبایل" className={styles.tabBar} data-testid="mobile-tab-bar">
      {TABS.map((tab) => {
        const current = isCurrent(pathname, tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={styles.tab}
            aria-current={current ? 'page' : undefined}
            data-tab={tab.href}
          >
            <span className={`${styles.tabGlyph} ${tab.glyph}`} aria-hidden="true" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
