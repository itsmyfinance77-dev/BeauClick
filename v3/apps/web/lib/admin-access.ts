import { toPersianDigits } from '@beauclick/persian-utils';

/**
 * Who gets which `/admin` — #264, `52_MODERATOR_LANDING.md` §2.
 *
 * One shared admin shell with two readings of the caller's LIVE capabilities
 * (`GET /v1/me`), decided here and nowhere else so the layout, the bar, the
 * landing and the header menu cannot disagree about it:
 *
 *  - `platform` — the caller holds `bc_manage_platform` (operator or
 *    administrator). Everything is exactly as it was before #264.
 *  - `moderation` — one or more `bc_moderate_*` and NO `bc_manage_platform`.
 *    `/admin` is the moderator landing, and only the moderation queues are
 *    reachable inside the shell.
 *  - `null` — neither. The existing no-access state.
 *
 * Like every other check in `apps/web`, this is a courtesy and not a control.
 * The control is `CapabilityGuard` on every admin route, with a per-request
 * re-read of privileged grants; `moderator-admin-boundary.pg-spec.ts` proves a
 * moderator is refused on every `bc_manage_platform` and
 * `bc_manage_commercial_plans` route.
 */

export type AdminMode = 'platform' | 'moderation';

export type ModerationCapability =
  | 'bc_moderate_verification'
  | 'bc_moderate_media'
  | 'bc_moderate_reviews'
  | 'bc_moderate_chat';

export interface ModerationQueue {
  capability: ModerationCapability;
  href: string;
  /** The card title and the bar label — the same words the bar already uses. */
  label: string;
}

/**
 * The four queues in the ONE fixed order the spec gives (verification · media ·
 * reviews · chat). Never sorted by count, never reordered by what is held.
 */
export const MODERATION_QUEUES: readonly ModerationQueue[] = [
  { capability: 'bc_moderate_verification', href: '/admin/verification', label: 'احراز هویت' },
  { capability: 'bc_moderate_media', href: '/admin/media', label: 'گزارش تصاویر' },
  { capability: 'bc_moderate_reviews', href: '/admin/reviews', label: 'بازبینی دیدگاه‌ها' },
  { capability: 'bc_moderate_chat', href: '/admin/chat-reports', label: 'گزارش گفتگوها' },
];

export function adminMode(capabilities: readonly string[] | null | undefined): AdminMode | null {
  const held = capabilities ?? [];
  if (held.includes('bc_manage_platform')) return 'platform';
  if (MODERATION_QUEUES.some((queue) => held.includes(queue.capability))) return 'moderation';
  return null;
}

/** The queues this caller holds, in the fixed order. */
export function heldModerationQueues(capabilities: readonly string[] | null | undefined): ModerationQueue[] {
  const held = capabilities ?? [];
  return MODERATION_QUEUES.filter((queue) => held.includes(queue.capability));
}

/**
 * The only routes the shell renders in `moderation` mode: the landing and the
 * four queue pages. Everything else under `/admin` — users, audit log,
 * settlements, privacy, search, notifications, phone conflicts, loyalty, every
 * `/admin/commercial/*` page — gets the no-access state before its own page
 * guard is even reached. Each queue page still applies its OWN capability
 * guard, so a partial moderator typing another queue's URL is refused there.
 */
export function isModerationRoute(pathname: string): boolean {
  if (pathname === '/admin') return true;
  return MODERATION_QUEUES.some((queue) => pathname === queue.href || pathname.startsWith(`${queue.href}/`));
}

/**
 * The limit the landing sends to `GET /v1/admin/chat/reports`, which answers
 * with at most `limit` items and NO total. Sent explicitly rather than relying
 * on the server's default, so the wording below compares against the limit
 * that was actually asked for.
 */
export const CHAT_REPORT_COUNT_LIMIT = 50;

export type QueueCount =
  /** A paginated queue's `meta.pagination.total`: an exact figure. */
  | { kind: 'exact'; value: number }
  /** The chat queue's `items.length`, which is exact only below the limit. */
  | { kind: 'bounded'; value: number; limit: number };

/** `52_MODERATOR_LANDING.md` §3's zero wording, shared by every card. */
export const EMPTY_QUEUE_WORDING = 'صف خالی است';

/**
 * The card's count sentence — §3 "Count wording", exactly.
 *
 * The three paginated queues say the server's total. The chat queue never
 * claims a total the server did not return: `n` below the limit is every open
 * report there is, but `n` AT the limit only means "the page was full", so it
 * is «دست‌کم n». Zero is the empty-queue sentence for both.
 */
export function queueCountWording(count: QueueCount): string {
  if (count.value === 0) return EMPTY_QUEUE_WORDING;
  const n = toPersianDigits(count.value);
  if (count.kind === 'exact') return `${n} مورد در صف`;
  return count.value >= count.limit ? `دست‌کم ${n} گزارش باز` : `${n} گزارش باز`;
}
