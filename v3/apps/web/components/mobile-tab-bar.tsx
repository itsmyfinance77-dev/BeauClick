'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { RefObject } from 'react';
import styles from './mobile-tab-bar.module.css';

/**
 * The bottom bar — `25_MOBILE_NAVIGATION.md` and
 * `V3_INFORMATION_ARCHITECTURE.md` §2–§3.
 *
 * Mobile is not a narrowed desktop. The spec settles the shape once for every
 * surface and says so in as many words: one component, one appearance — 56px,
 * the `bar` shadow, at most five destinations, `aria-current` on the active
 * one — and "تفاوت بسترها فقط در کدام مقصدها روی نوار می‌نشینند، نه در جزء".
 * So this component knows nothing about who is calling it; each shell passes
 * its own destinations.
 *
 * The customer gets five, chosen on one rule: things a customer does several
 * times a month. The professional gets two plus a trigger, because the rest of
 * that column's work is desktop work (§3: «امروز» و «رزروها» در نوار پایین
 * می‌مانند). `/admin` gets no bottom bar at all — administration on a phone is
 * rare enough that building one would invent a surface nobody uses.
 *
 * Only shown below 640px — the stylesheet, not this component, decides that,
 * so there is no viewport guess in JavaScript and no hydration mismatch.
 *
 * Each tab carries a distinct glyph SHAPE as well as its colour: the current
 * destination must be identifiable without relying on colour. The caller names
 * a shape rather than passing a class, so the stylesheet stays the component's
 * own rather than something every shell has to reach into.
 */

export type TabGlyph = 'home' | 'search' | 'bookings' | 'loyalty' | 'account' | 'today' | 'more';

const GLYPHS: Record<TabGlyph, string> = {
  home: styles.tabGlyphHome,
  search: styles.tabGlyphSearch,
  bookings: styles.tabGlyphBookings,
  loyalty: styles.tabGlyphLoyalty,
  account: styles.tabGlyphAccount,
  today: styles.tabGlyphToday,
  more: styles.tabGlyphMore,
};

export interface MobileTab {
  href: string;
  label: string;
  glyph: TabGlyph;
  /**
   * Matches this path only, never its subtree. Both bars have one destination
   * that is also the PARENT of others — `/` for the customer, `/pro` for the
   * professional — and only the caller knows which of its hrefs is that kind.
   * Without it, «امروز» reads as current while the professional is on
   * `/pro/bookings`, which is a different tab in the same bar.
   */
  exact?: boolean;
}

/**
 * The one control on the bar that is not a destination: it opens the sheet
 * holding everything that did not fit. `controls` is the sheet's id, so the
 * relationship is announced rather than only drawn.
 */
export interface MobileTabTrigger {
  label: string;
  glyph: TabGlyph;
  open: boolean;
  controls: string;
  onToggle: () => void;
}

function isCurrent(pathname: string, tab: MobileTab): boolean {
  return tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

export function MobileTabBar({
  tabs,
  trigger,
  triggerRef,
}: {
  tabs: readonly MobileTab[];
  /** Omitted by a surface whose destinations all fit — the customer's five. */
  trigger?: MobileTabTrigger;
  /** So the caller can return focus here when its sheet closes. */
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const pathname = usePathname() ?? '/';

  return (
    <nav aria-label="ناوبری موبایل" className={styles.tabBar} data-testid="mobile-tab-bar">
      {tabs.map((tab) => {
        const current = isCurrent(pathname, tab);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={styles.tab}
            aria-current={current ? 'page' : undefined}
            data-tab={tab.href}
          >
            <span className={`${styles.tabGlyph} ${GLYPHS[tab.glyph]}`} aria-hidden="true" />
            {tab.label}
          </Link>
        );
      })}

      {trigger ? (
        <button
          type="button"
          ref={triggerRef}
          className={styles.tab}
          aria-expanded={trigger.open}
          aria-haspopup="dialog"
          aria-controls={trigger.controls}
          onClick={trigger.onToggle}
          data-tab="trigger"
        >
          <span className={`${styles.tabGlyph} ${GLYPHS[trigger.glyph]}`} aria-hidden="true" />
          {trigger.label}
        </button>
      ) : null}
    </nav>
  );
}
