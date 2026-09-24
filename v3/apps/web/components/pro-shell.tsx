'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { useProProfile } from '@/lib/pro-context';
import { ProMobileNav } from './pro-mobile-nav';
import { PRO_NAV, isCurrentProNav } from './pro-nav';
import { VerificationBadge } from './pro-verification';
import styles from './pro-shell.module.css';

/**
 * The professional's shell — `Prototype - Pro and Admin.dc.html` §01 and
 * `V3_INFORMATION_ARCHITECTURE.md` §3.
 *
 * ## From a horizontal band to a fixed column
 *
 * The context band was the right IDEA in the wrong shape. It named the mode,
 * showed who you were operating as and offered the way out — and it carried
 * eight destinations in a row that does not hold eight. The information
 * architecture is explicit: "navigation moves from `pro-shell.tsx`'s
 * seven-item horizontal bar to a FIXED SIDE COLUMN, because seven do not fit
 * a horizontal bar and break on mobile; in a column all seven are always
 * visible and there is room for a counter."
 *
 * Everything the band did, the column's head still does: identity,
 * verification status, and the exit. `ContextBand` and `NavLink` had no
 * users left once the operator's bar moved too, so both were deleted rather
 * than kept as a kit nobody imports.
 *
 * The shell still sits INSIDE `AppShell` rather than replacing it: a separate
 * chrome would mean a second header, a second skip-link target and a second
 * place for the notification badge to drift out of sync.
 *
 * ## Three widths, because a column is only right at one of them
 *
 * From 1024 up it is the column the architecture asks for. Between 640 and
 * 1024 it is a horizontal scroller: every destination stays reachable and the
 * row is honest about there being more. Below 640 the column is gone
 * altogether and `ProMobileNav` takes over — §3's own instruction, "موبایل:
 * ستون به یک برگهٔ کشویی می‌رود؛ «امروز» و «رزروها» در نوارِ پایین می‌مانند".
 *
 * Neither document specifies the 640–1024 band. The scroller stays there
 * rather than being replaced by a two-destination bar and a sheet, which shows
 * less at a width that has room for more.
 */

export function ProShell({ children }: { children: ReactNode }) {
  const { profile, state, upcomingBookings } = useProProfile();
  const pathname = usePathname() ?? '/pro';
  const ready = state === 'ready' && profile;

  /*
   * The badge is absent for an UNKNOWN count and for a genuine zero alike, and
   * those are not the same thing -- #282. `upcomingBookings` is null when the
   * read failed or has not happened, and zero when the server said zero.
   * Neither draws anything, because «۰» beside «رزروها» is noise either way;
   * only `/pro/bookings`'s own tab label distinguishes them, where there is room
   * to.
   */
  const showCount = upcomingBookings !== null && upcomingBookings > 0;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.identity}>
          <Link href="/pro" className={styles.brand}>
            {/* The static brand mark from `public/`. */}
            <img src="/brand/icon-circle.svg" alt="" width={24} height={24} className={styles.brandMark} />
            <span className={styles.brandName}>BeauClick</span>
          </Link>
          {ready ? (
            <div className={styles.who} data-testid="pro-identity">
              <span className={styles.avatar} aria-hidden="true" />
              <div className={styles.whoMain}>
                <div className={styles.whoName}>{profile.displayName}</div>
                <VerificationBadge status={profile.verificationStatus} />
              </div>
            </div>
          ) : null}
        </div>

        <nav aria-label="ناوبری متخصص" className={styles.nav}>
          {PRO_NAV.map((item) => (
            <span key={item.href} className={styles.navItem}>
              {item.separatorBefore ? <span className={styles.separator} aria-hidden="true" /> : null}
              <Link
                href={item.href}
                className={styles.link}
                aria-current={isCurrentProNav(pathname, item) ? 'page' : undefined}
                data-pro-nav={item.href}
              >
                {item.label}
                {item.badge === 'upcomingBookings' && showCount ? (
                  /*
                   * Inside the link, so the number is announced as part of the
                   * destination rather than as a loose figure beside it, and the
                   * hidden half says what the figure counts — «۳» on its own
                   * names nothing.
                   */
                  <span className={styles.count} data-testid="pro-nav-upcoming-count">
                    <span aria-hidden="true">{toPersianDigits(upcomingBookings)}</span>
                    <span className="bc-visually-hidden">{`${toPersianDigits(upcomingBookings)} رزرو پیش‌رو`}</span>
                  </span>
                ) : null}
              </Link>
            </span>
          ))}
        </nav>

        <Link href="/" className={styles.exit}>
          <span className={styles.exitChevron} aria-hidden="true" />
          بازگشت به نمای مشتری
        </Link>
      </aside>

      <div className={styles.content}>{children}</div>

      {/* Below 640 only; the stylesheets decide, so there is no viewport
          guess here and nothing to mismatch on hydration. */}
      <ProMobileNav />
    </div>
  );
}
