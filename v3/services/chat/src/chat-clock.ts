/**
 * The injected clock.
 *
 * Three of this module's rules are time: sending closes 90 days after the last
 * qualifying booking (`V32-DEC-012`), a conversation is destroyed 24 months after
 * its last message (`V32-DEC-013`), and the send throttle counts per minute
 * (`V32-DEC-014`).
 *
 * A rule that reads `new Date()` directly can only be tested by waiting, or by
 * writing rows with fabricated timestamps and hoping the fabrication matches what
 * production would produce. Both are how a boundary condition ends up unproved —
 * and boundary conditions are exactly what a retention policy is: 24 months is
 * trivially right at month 3 and month 300, and interesting only at month 24.
 *
 * Nothing else in this module calls `Date.now()`.
 *
 * ## Why there is no timezone here, unlike `ai`
 *
 * `ai`'s quota is twenty messages per **Tehran calendar day** — a promise about a
 * person's calendar, so it needs a calendar. Every chat rule is a duration
 * between two instants: 90 days after a slot ended, 24 months after a message,
 * one minute of sending. Introducing a calendar boundary would add a
 * discontinuity nobody benefits from, and would make "90 days" mean something
 * subtly different for a customer who booked at 23:00 than for one who booked at
 * 01:00.
 */
export interface ChatClock {
  now(): Date;
}

export const CHAT_CLOCK = Symbol('BEAUCLICK_CHAT_CLOCK');

export const systemChatClock: ChatClock = {
  now: () => new Date(),
};

/**
 * The start of the minute an instant falls in, in UTC.
 *
 * The bucket key for `chat.send_counters`. Bucketing rather than a rolling
 * window is a contention decision: one counter row per user, rewritten on every
 * send, becomes the hottest row in the schema and serialises every sender against
 * every other. Bucketing by minute means concurrent senders in different minutes
 * touch different rows, and the conditional increment only ever serialises
 * senders inside the same minute — which is precisely the set the limit is about.
 */
export function minuteBucket(instant: Date): Date {
  const bucket = new Date(instant.getTime());
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

/** The instant a conversation with this last-message time ages out. */
export function retentionCutoff(now: Date, retentionMonths: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
  return cutoff;
}
