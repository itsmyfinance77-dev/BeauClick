'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useProProfile } from '@/lib/pro-context';
import { MobileTabBar } from './mobile-tab-bar';
import { VerificationBadge } from './pro-verification';
import { PRO_SHEET_ITEMS, PRO_BAR_TABS, isCurrentProNav } from './pro-nav';
import styles from './pro-mobile-nav.module.css';

/**
 * The professional's navigation below 640 — `25_MOBILE_NAVIGATION.md` and
 * `V3_INFORMATION_ARCHITECTURE.md` §3.
 *
 * Nine destinations in a fixed column work from 1024 up and scroll sideways
 * between 640 and 1024. On a phone neither holds: §3 sends the column to a
 * slide-up sheet and keeps «امروز» and «رزروها» on the bottom bar. The bar is
 * the SAME component the customer's five destinations use, per spec 25's
 * "تفاوت بسترها فقط در کدام مقصدها روی نوار می‌نشینند، نه در جزء" — this file
 * supplies the professional's destinations and the sheet, and no bar of its
 * own.
 *
 * ## The sheet carries the whole column, not its links
 *
 * Below 640 the column is hidden, so identity, verification status and the way
 * back to the customer view would be gone from every professional page on a
 * phone. They are the reason the column has a head and a foot at all, so the
 * sheet reproduces all three.
 *
 * ## Focus and dismissal
 *
 * The contract `kit.tsx`'s dialog established: focus moves into the sheet on
 * open and returns to the trigger on close, Tab cycles inside it, Escape and a
 * tap on the scrim close it. A route change closes it too — a sheet still up
 * over the page it navigated to would be a second thing to dismiss.
 */
export function ProMobileNav() {
  const { profile, state } = useProProfile();
  const pathname = usePathname() ?? '/pro';
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  // A drag that STARTS on a link and ends over the scrim fires a click whose
  // target is the scrim; without this the sheet would close on a text
  // selection. `kit.tsx`'s dialog found the same thing.
  const pressedInside = useRef(false);
  const sheetId = useId();
  const ready = state === 'ready' && profile;

  const close = useCallback(() => setOpen(false), []);

  // A navigation leaves the sheet mounted, so closing has to be driven by the
  // path rather than by the click: a keyboard Enter on a link, or a browser
  // back, would otherwise leave it open over a different page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const sheet = panel.current;
    const focusables = () =>
      Array.from(
        sheet?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [],
      );

    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      // From 640 up the stylesheet hides this sheet outright. A viewport that
      // GREW while it was open leaves it mounted but invisible, and a sheet
      // nobody can see must not be holding the keyboard hostage. Escape above
      // still works, so it is never stuck either way.
      if (scrim.current && getComputedStyle(scrim.current).display === 'none') return;

      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap both ways. Without this, Tab from the last link lands on the
      // page behind the sheet, which is exactly what a modal must not allow.
      if (event.shiftKey && (active === first || !sheet?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      trigger.current?.focus();
    };
  }, [open]);

  return (
    <>
      <MobileTabBar
        tabs={PRO_BAR_TABS}
        triggerRef={trigger}
        trigger={{
          label: 'منو',
          glyph: 'more',
          open,
          controls: sheetId,
          onToggle: () => setOpen((was) => !was),
        }}
      />

      {open ? (
        <div
          ref={scrim}
          className={styles.scrim}
          data-testid="pro-nav-scrim"
          onMouseDown={(event) => {
            pressedInside.current = panel.current?.contains(event.target as Node) ?? false;
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !pressedInside.current) close();
            pressedInside.current = false;
          }}
        >
          <div
            ref={panel}
            id={sheetId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${sheetId}-title`}
            className={styles.panel}
            data-testid="pro-nav-sheet"
          >
            <div className={styles.head}>
              <h2 id={`${sheetId}-title`} className={styles.title}>
                مقصدهای دیگر
              </h2>
              <button type="button" className={styles.close} aria-label="بستن" onClick={close} />
            </div>

            {ready ? (
              <div className={styles.who} data-testid="pro-sheet-identity">
                <span className={styles.avatar} aria-hidden="true" />
                <div className={styles.whoText}>
                  <div className={styles.whoName}>{profile.displayName}</div>
                  <VerificationBadge status={profile.verificationStatus} />
                </div>
              </div>
            ) : null}

            <nav aria-label="مقصدهای دیگر متخصص" className={styles.list}>
              {PRO_SHEET_ITEMS.map((item) => (
                <span key={item.href} className={styles.item}>
                  {item.separatorBefore ? <span className={styles.separator} aria-hidden="true" /> : null}
                  <Link
                    href={item.href}
                    className={styles.link}
                    aria-current={isCurrentProNav(pathname, item) ? 'page' : undefined}
                    data-sheet-nav={item.href}
                  >
                    {item.label}
                  </Link>
                </span>
              ))}
            </nav>

            <Link href="/" className={styles.exit}>
              <span className={styles.exitChevron} aria-hidden="true" />
              بازگشت به نمای مشتری
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
