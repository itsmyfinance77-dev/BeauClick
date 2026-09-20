'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './app-shell.module.css';

/**
 * The account menu — `V3_INFORMATION_ARCHITECTURE.md` §2, level three.
 *
 * The eleven-destination header put «خروج» at the same visual weight as
 * «جست‌وجو». Five low-frequency destinations moved here: the waitlist,
 * registering as a professional, the caller's business, professional mode,
 * and signing out. What stays in the header is what a customer uses weekly.
 *
 * ## Keyboard and focus
 *
 * `Escape` closes and returns focus to the trigger, a click outside closes,
 * and the trigger carries `aria-expanded` and `aria-haspopup`. The menu is
 * not a `role="menu"`: its contents are ordinary links plus one button, and
 * announcing them as menu items would promise arrow-key semantics that a
 * link list does not have.
 */

export interface AvatarMenuEntry {
  label: string;
  href: string;
}

export function AvatarMenu({
  displayName,
  identity,
  entries,
  onSignOut,
}: {
  /** What the trigger shows. Falls back to a neutral word, never to a phone number. */
  displayName: string;
  /** The phone or account identifier, shown once inside the menu in an LTR run. */
  identity: string | null;
  entries: AvatarMenuEntry[];
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    function onPointer(event: MouseEvent) {
      if (wrap.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  return (
    <div className={styles.avatarWrap} ref={wrap} data-testid="avatar-menu">
      <button
        type="button"
        ref={trigger}
        className={styles.avatarButton}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`حساب کاربری، ${displayName}`}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.avatarName}>{displayName}</span>
        <span className={styles.avatarChip} aria-hidden="true" />
      </button>

      {open ? (
        <div className={styles.menu} data-testid="avatar-menu-items">
          {identity ? <div className={styles.menuIdentity}>{identity}</div> : null}
          {entries.map((entry) => (
            <Link key={entry.href} href={entry.href} className={styles.menuItem} onClick={() => setOpen(false)}>
              {entry.label}
            </Link>
          ))}
          <div className={styles.menuSeparator} aria-hidden="true" />
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            خروج
          </button>
        </div>
      ) : null}
    </div>
  );
}
