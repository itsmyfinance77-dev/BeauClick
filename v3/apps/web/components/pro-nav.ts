import type { MobileTab, TabGlyph } from './mobile-tab-bar';

/**
 * The professional's destinations, in the design's order —
 * `V3_INFORMATION_ARCHITECTURE.md` §3's table.
 *
 * One list, read by three surfaces: the fixed column from 1024 up, the
 * horizontal scroller between 640 and 1024, and — below 640 — a two-tab
 * bottom bar plus a sheet. The bar and the sheet are DERIVED from this list
 * rather than written out again, so a destination added here cannot be
 * reachable on a desktop and missing on a phone.
 */
export interface ProNavItem {
  href: string;
  label: string;
  /**
   * `true` marks where the design's rule falls — the daily work above it, the
   * occasional destinations below.
   */
  separatorBefore?: boolean;
  /**
   * Present for the destinations §3 keeps on the bottom bar ("«امروز» و
   * «رزروها» در نوار پایین می‌مانند"), and names the shape the bar draws for
   * it. Everything without it goes to the sheet.
   */
  bar?: TabGlyph;
  /**
   * Matches this path only, never its subtree. `/pro` is both a destination
   * and the prefix of every other professional path, so without this it would
   * read as the current one from «زمان‌های آزاد» to «شرایط لغو».
   */
  exact?: true;
  /**
   * Which count sits beside this destination in the column — §3's
   * «+ شمارندهٔ پیش‌رو», and the reason §3 gives for moving to a column in the
   * first place: «جای شمارنده هم هست».
   *
   * Names the count, never the number. This list is static data read by three
   * surfaces; resolving a figure here would turn it into a component.
   */
  badge?: 'upcomingBookings';
}

export const PRO_NAV: ProNavItem[] = [
  // Renamed per the information architecture: this page is today's work,
  // and «نمای کلی» described a summary it is not.
  { href: '/pro', label: 'امروز', bar: 'today', exact: true },
  { href: '/pro/bookings', label: 'رزروها', bar: 'bookings', badge: 'upcomingBookings' },
  { href: '/pro/availability', label: 'زمان‌های آزاد' },
  { href: '/pro/services', label: 'خدمات' },
  { href: '/pro/finance', label: 'مالی' },
  { href: '/pro/analytics', label: 'آمار' },
  // V3.3 `#42b` / #159. Beside «مالی» rather than inside it: the terms
  // decide what a cancellation COSTS, which is an operating decision the
  // seller makes once, not a figure they read.
  { href: '/pro/outcome-policy', label: 'شرایط لغو' },
  // #328. The conversations addressed to this professional profile; the
  // header's messages entry opens the whole inbox, this one the seller half.
  { href: '/pro/messages', label: 'پیام‌ها' },
  { href: '/pro/profile', label: 'پروفایل عمومی', separatorBefore: true },
  { href: '/business', label: 'کسب‌وکار' },
];

/** The two §3 keeps on the bar, in the order they appear in the column. */
export const PRO_BAR_TABS: MobileTab[] = PRO_NAV.filter((item) => item.bar).map((item) => ({
  href: item.href,
  label: item.label,
  // Narrowed by the filter above; `bar` is what put the item in this list.
  glyph: item.bar as TabGlyph,
  exact: item.exact,
}));

/** «باقی هفت مقصد در یک برگهٔ کشویی از دکمهٔ منو» — everything else. */
export const PRO_SHEET_ITEMS: ProNavItem[] = PRO_NAV.filter((item) => !item.bar);

/**
 * One rule for every surface that draws this list. The column, the scroller
 * and the sheet all mark the current destination, and three copies of the
 * same comparison is three places for `/pro` to start swallowing its subtree
 * again.
 */
export function isCurrentProNav(pathname: string, item: ProNavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
