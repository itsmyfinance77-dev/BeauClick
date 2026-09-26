import type { DataSource, EntityManager } from 'typeorm';

/**
 * The public completed-booking count -- #226.
 *
 * A number about a seller that any visitor reads on their profile
 * («N نوبت انجام‌شده»), and therefore a number that has to mean the same thing
 * every time it is asked and be hard to move. This file is where "the same
 * thing" is written down.
 *
 * ## The definition
 *
 * A booking counts when, and only when, ALL of these hold at the moment of the
 * read:
 *
 *  1. it belongs to this professional (`professional_id`), which is the
 *     authoritative link -- `bookings.professional_id` is the professional's own
 *     id, not their owner's user id and not their business;
 *  2. its final status is `completed` -- not `pending`, `confirmed`,
 *     `cancelled`, `expired` or `no_show`;
 *  3. its appointment has ended: `slot_end <= now()`, by the DATABASE's clock.
 *
 * Lifetime: there is no window, so the figure only ever grows as bookings
 * complete and their slot ends. It is a non-negative integer.
 *
 * ## Why the third rule exists
 *
 * `BookingService.complete` moves `confirmed -> completed` for the professional
 * at any moment -- there is no "the appointment has ended" precondition on that
 * transition, because a professional may legitimately close out early. Without
 * this rule a seller could mark tomorrow's confirmed appointments completed
 * today and put them on their own profile. With it, a booking that is marked
 * complete early stops being counted-in-waiting and simply begins to count at
 * its end instant, with no further action by anyone.
 *
 * `slot_end` is the booking's own copy of its slot's end (denormalised at claim
 * time and rewritten on a reschedule, `BookingEntity.slotEnd`), so "the
 * authoritative appointment end" is the appointment as it finally stood after
 * any reschedule. A rescheduled booking is still ONE row, so it is counted once.
 *
 * The clock is `now()` in the database and never a value passed in from Node or
 * from a request: the API process's clock is not the one the slot instants were
 * validated against, and a caller-supplied instant would be a way to move the
 * number.
 *
 * ## What it deliberately does not do
 *
 * It reads no customer, no order and no amount, and returns one integer: there
 * is no way for a caller of this function to learn who booked, when, or what
 * they paid. It counts each booking regardless of who the customer is, so it
 * cannot see (and does not claim to detect) a seller completing bookings booked
 * from their own second account. What keeps that from being free is that no
 * route lets anybody confirm a booking: only the system does, in checkout, on a
 * verified payment capture or on a zero-collectible confirmation that passes the
 * booking-credit entitlement (`checkout.service.ts`).
 *
 * The `(professional_id, status)` index (`ix_bookings_professional_status`)
 * serves it: one indexed count per profile read.
 */
export const PUBLIC_COMPLETED_BOOKING_COUNT_SQL = `
  SELECT count(*)::int AS completed
    FROM booking.bookings
   WHERE professional_id = $1
     AND status = 'completed'
     AND slot_end <= now()
`;

/** The one place a caller asks the question. `db` is a DataSource or the caller's own manager. */
export async function countPublicCompletedBookings(
  db: Pick<DataSource | EntityManager, 'query'>,
  professionalId: string,
): Promise<number> {
  const rows: Array<{ completed: number | string }> = await db.query(PUBLIC_COMPLETED_BOOKING_COUNT_SQL, [professionalId]);
  const completed = Number(rows[0]?.completed ?? 0);
  // A count cannot be negative or fractional; if it somehow is, say nothing
  // rather than publish a number the definition does not allow.
  return Number.isInteger(completed) && completed >= 0 ? completed : 0;
}
