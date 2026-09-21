'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import styles from './tab-list.module.css';

/**
 * A real tablist: `role="tablist"` with `role="tab"` children, exactly one
 * `aria-selected`, `aria-controls` pointing at a `role="tabpanel"`, and the
 * keyboard model the ARIA authoring practices give it — one tab stop for the
 * whole list (roving `tabindex`), arrow keys to move between tabs, Home and End
 * to jump.
 *
 * `V3.3` spec 05 calls the professional's bookings the only place in the
 * product with a genuine tablist; the buttons it had carried the roles and
 * nothing else, so every tab was a tab stop, no arrow key did anything, and no
 * tab was tied to what it revealed.
 *
 * Arrow direction follows the reading direction: in a right-to-left document
 * the tab that comes NEXT is drawn to the left, so ArrowLeft moves forward.
 * Selection follows focus (automatic activation), which is the right default
 * for a list whose panels are already in memory.
 */
export type TabDefinition<T extends string> = { value: T; label: string };

function isRtl(element: HTMLElement): boolean {
  const own = element.closest('[dir]')?.getAttribute('dir');
  return (own ?? document.documentElement.getAttribute('dir') ?? 'ltr').toLowerCase() === 'rtl';
}

export function tabId(prefix: string, value: string): string {
  return `${prefix}-tab-${value}`;
}

export function panelId(prefix: string): string {
  return `${prefix}-panel`;
}

export function TabList<T extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
}: {
  /** Accessible name for the list. Never omitted. */
  label: string;
  /** Makes the tab and panel ids unique on the page. */
  idPrefix: string;
  tabs: readonly TabDefinition<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Focus follows a keyboard move, and is applied AFTER the render in which the
  // new tab became the selected one (an effect, not a timer: a timer can be
  // throttled or skipped when the page is not being drawn).
  const focusAfterRender = useRef<string | null>(null);

  useEffect(() => {
    const wanted = focusAfterRender.current;
    if (wanted === null) return;
    focusAfterRender.current = null;
    listRef.current?.querySelector<HTMLElement>(`[id="${tabId(idPrefix, wanted)}"]`)?.focus();
  }, [value, idPrefix]);

  function move(to: number) {
    const target = tabs[(to + tabs.length) % tabs.length];
    focusAfterRender.current = target.value;
    onChange(target.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((t) => t.value === value);
    const rtl = listRef.current ? isRtl(listRef.current) : false;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';

    if (event.key === forward) move(current + 1);
    else if (event.key === back) move(current - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(tabs.length - 1);
    else return;
    event.preventDefault();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            id={tabId(idPrefix, tab.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(idPrefix)}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.selected : ''}`}
            onClick={() => onChange(tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The one panel a `TabList` controls, labelled by the selected tab. */
export function TabPanel({
  idPrefix,
  value,
  children,
}: {
  idPrefix: string;
  /** The selected tab's value. */
  value: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={panelId(idPrefix)} aria-labelledby={tabId(idPrefix, value)} tabIndex={0} className={styles.panel}>
      {children}
    </div>
  );
}
