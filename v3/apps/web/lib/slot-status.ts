import type { BadgeTone } from '@/components/kit';

/**
 * How an availability slot's status is named and toned on screen.
 *
 * Keys are the server's `SLOT_STATUSES` (`availability-slot.entity.ts`):
 * `open`, `held`, `booked`. This page's table also carried `blocked`, and the
 * `MySlot` type listed it — a status the server has never had, so nothing
 * would ever render it and a reader of the type would think a fourth state
 * existed. `slot-status.spec.ts` reads the server's list and fails when the
 * two drift apart, in either direction.
 */
export const SLOT_STATUS_LABEL: Record<string, string> = {
  open: 'آزاد',
  held: 'در حال رزرو',
  booked: 'رزرو شده',
};

export const SLOT_STATUS_TONE: Record<string, BadgeTone> = {
  open: 'success',
  held: 'warning',
  booked: 'primary',
};

/** For a status this client has never heard of: a neutral word, never the raw key. */
export const UNKNOWN_SLOT_STATUS_LABEL = 'نامشخص';

export function slotStatusLabel(status: string): string {
  return SLOT_STATUS_LABEL[status] ?? UNKNOWN_SLOT_STATUS_LABEL;
}

export function slotStatusTone(status: string): BadgeTone {
  return SLOT_STATUS_TONE[status] ?? 'neutral';
}
