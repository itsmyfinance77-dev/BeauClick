/**
 * How a journey timeline entry is named on screen.
 *
 * The server sends `type` (an enum key) and a Persian `label` for it
 * (`TIMELINE_LABELS` in `journey.controller.ts`, kept out of the database so
 * a wording fix applies to old rows too). Two things it does not send, and
 * that `09_JOURNEY.md` asks for:
 *
 *   - a KIND — goal, booking, payment, membership — so each entry can carry an
 *     explicit spoken label, not just a sentence;
 *   - a fallback: for a `type` the server has no label for, its own code falls
 *     back to the raw enum key, and `booking_refunded` must never be shown to
 *     a customer as `booking_refunded`.
 *
 * One file, one table: adding an event type on the server means adding a line
 * here, and `journey-timeline.spec.ts` reads the server's table to fail if the
 * two drift apart.
 */
export type TimelineKind = 'goal' | 'booking' | 'payment' | 'membership';

export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  goal: 'هدف',
  booking: 'رزرو',
  payment: 'پرداخت',
  membership: 'باشگاه',
};

export const TIMELINE_KIND_BY_TYPE: Record<string, TimelineKind> = {
  goal_created: 'goal',
  goal_achieved: 'goal',
  booking_created: 'booking',
  booking_confirmed: 'booking',
  booking_completed: 'booking',
  booking_cancelled: 'booking',
  order_paid: 'payment',
  loyalty_tier_changed: 'membership',
  membership_activated: 'membership',
};

/** What is shown for an event the client has never heard of. */
export const UNKNOWN_EVENT_LABEL = 'فعالیت';

export function timelineKind(type: string): TimelineKind | null {
  return TIMELINE_KIND_BY_TYPE[type] ?? null;
}

/**
 * The server's label, unless it is just the enum key echoed back (the server's
 * own fallback) — which is ASCII snake_case and never a sentence a person
 * would read.
 */
export function timelineLabel(entry: { type: string; label: string }): string {
  const echoed = entry.label === entry.type || /^[a-z]+(_[a-z]+)*$/.test(entry.label);
  return echoed ? UNKNOWN_EVENT_LABEL : entry.label;
}
