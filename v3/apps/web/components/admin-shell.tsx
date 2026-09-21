'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import styles from './admin-shell.module.css';

/**
 * The admin context bar.
 *
 * Deliberately the same PATTERN as `ProShell` and deliberately a different
 * COLOUR. Task 1 established that a role context is a tinted band under the app
 * header carrying a mode badge, who you are acting as, the mode's own nav, and
 * a permanent way out.
 *
 * Phase A copied that structure here on the reasoning that "re-deciding it
 * would produce a second convention". True, but copying produced two
 * implementations of one convention, which is the same problem one refactor
 * later -- so Phase G moved the structure into `ContextBand` and left this file
 * holding only what is genuinely admin-specific.
 *
 * The colour is one of those specifics, and it carries meaning rather than
 * decoration. A professional acting in the wrong context edits their own
 * catalogue; an operator acting in the wrong context settles somebody else's
 * money. The band uses the warning token so "you are in the admin panel" is not
 * something the user has to read to know.
 */

const ADMIN_NAV: { href: string; label: string; capability?: string; system?: boolean }[] = [
  { href: '/admin', label: 'نمای کلی' },
  { href: '/admin/verification', label: 'احراز هویت', capability: 'bc_moderate_verification' },
  // #238. Beside «احراز هویت» because all three are one-at-a-time review queues
  // with a mandatory reason — the placement specs 27 and 28 propose and leave
  // as a product decision.
  { href: '/admin/media', label: 'گزارش تصاویر', capability: 'bc_moderate_media' },
  { href: '/admin/reviews', label: 'بازبینی دیدگاه‌ها', capability: 'bc_moderate_reviews' },
  { href: '/admin/users', label: 'کاربران و نقش‌ها' },
  { href: '/admin/audit-log', label: 'گزارش عملیات' },
  { href: '/admin/settlements', label: 'تسویه‌ها' },
  { href: '/admin/search', label: 'جست‌وجو' },
  { href: '/admin/notifications', label: 'اعلان‌ها', system: true },
  { href: '/admin/phone-conflicts', label: 'تعارض شماره' },
  { href: '/admin/loyalty', label: 'باشگاه' },
  // V3.3 `#43b-1` / #173. The first commercial entry; capability-gated so an
  // operator without it is never offered a route they cannot open.
  { href: '/admin/commercial/commission-policies', label: 'سیاست کمیسیون', capability: 'bc_manage_commercial_plans' },
];

/** `/admin` matches only itself; every other destination owns its subtree. */
function isCurrent(pathname: string, href: string): boolean {
  return href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The operator's bar — `V3_COMPONENT_INVENTORY.md`: "AdminShell: redesign —
 * dark bar; queue counter on the destination."
 *
 * ## Why dark
 *
 * Every other context in the product is light. This is the one place where
 * an action is taken ON somebody else's account, and the bar is what makes
 * that impossible to forget. The UI/UX audit's §4 finding was that V3 had no
 * visual distinction between contexts at all; the tinted band was the first
 * answer to it and this is the one the inventory asks for.
 *
 * The artboard also inverts the whole admin PAGE. That belongs to the admin
 * overview SCREEN, not to this component: inverting eleven pages whose
 * content is styled against light tokens is its own piece of work, and doing
 * half of it would leave dark chrome over light content.
 *
 * ## Counters live on the destination
 *
 * A queue depth shown only on an overview is a number an operator has to go
 * looking for. On the destination it is the reason to go there. The counts
 * are passed in by whoever knows them and are absent until then — a bar that
 * renders «۰» it did not measure would be worse than one that renders
 * nothing.
 */
export function AdminShell({ children, queues }: { children: ReactNode; queues?: Record<string, number> }) {
  const { user } = useAuth();
  const pathname = usePathname() ?? '/admin';
  const capabilities = user?.capabilities ?? [];

  // Hiding a link the operator cannot use is a courtesy, not a control: the
  // API refuses the request regardless of what the nav shows, and the
  // `operability-foundation.pg-spec` suite proves that for every route here.
  const visible = ADMIN_NAV.filter((item) => !item.capability || capabilities.includes(item.capability));
  const operatorCapabilities = capabilities.filter(
    (c) => c.startsWith('bc_manage_platform') || c.startsWith('bc_moderate'),
  );
  const identity = user?.displayName ?? user?.phone ?? null;

  return (
    <div>
      <div className={styles.bar} data-testid="admin-bar">
        <div className={styles.barStart}>
          <span className={styles.mode}>بیوکلیک — مدیریت</span>
          <nav aria-label="ناوبری مدیریت" className={styles.nav}>
            {visible.map((item) => {
              const count = queues?.[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={styles.link}
                  aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
                  data-admin-nav={item.href}
                  // The count is in the name, so it is announced rather than
                  // read out as a bare digit beside a word.
                  aria-label={count ? `${item.label}، ${toPersianDigits(count)} در صف` : undefined}
                >
                  {item.label}
                  {count ? (
                    <span
                      className={`${styles.count} ${item.system ? styles.countSystem : ''}`}
                      aria-hidden="true"
                    >
                      {toPersianDigits(count)}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className={styles.barEnd}>
          {/*
            The operator's REAL capabilities, shown rather than implied.
            Somebody acting on the platform should be able to see the extent
            of their own authority without asking anyone — the property the
            context band established, kept through the change of shape.
          */}
          {operatorCapabilities.length > 0 ? (
            <span className={styles.scopes} data-testid="admin-scopes">
              {operatorCapabilities.map((capability) => (
                <span key={capability} className={styles.scope}>
                  {CAPABILITY_LABELS[capability] ?? capability}
                </span>
              ))}
            </span>
          ) : null}
          {identity ? <span className={styles.operator}>{identity}</span> : null}
          <Link href="/" className={styles.exit}>
            خروج از پنل مدیریت
          </Link>
        </div>
      </div>

      {children}
    </div>
  );
}

/**
 * Persian labels for the capabilities an operator can hold.
 *
 * Falls back to the raw slug, which QA-22 records as the codebase's standing
 * habit -- acceptable HERE and nowhere user-facing: this band is only ever seen
 * by an operator, for whom `bc_manage_platform` is a meaningful string rather
 * than leaked English. The customer surfaces do not get that latitude.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  bc_manage_platform: 'مدیریت پلتفرم',
  bc_moderate_verification: 'بررسی احراز هویت',
  bc_moderate_reviews: 'بررسی دیدگاه‌ها',
  bc_moderate_media: 'بررسی تصاویر',
};
