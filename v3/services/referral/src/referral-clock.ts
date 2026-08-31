/**
 * The injected clock (ADR-036 §5).
 *
 * Three of this module's rules are time, and all three are **boundaries** —
 * which is precisely the kind of rule that goes unproved when it reads the wall
 * clock directly:
 *
 *  * a claimant's account must be **no more than 30 days old** (`V32-DEC-019`,
 *    Issue #27);
 *  * a pending attribution expires **90 days** after it was formed
 *    (`V32-DEC-017`);
 *  * the claim throttle counts **per hour** (`V32-DEC-019`).
 *
 * A rule that calls `new Date()` can only be tested by waiting, or by writing
 * rows with fabricated timestamps and hoping the fabrication matches what
 * production would produce. Both are how a boundary condition ends up unproved,
 * and a boundary is the entire content of these three rules: 30 days is
 * trivially right at day 3 and day 300 and interesting only at day 30.
 *
 * `ChatClock` is the same seam for the same reason. **Nothing else in this
 * module calls `Date.now()` or `new Date()`.**
 *
 * ## Why there is no timezone here, unlike `ai` — and unlike Story #12
 *
 * Every rule in this file is a **duration between two instants**. `ai`'s quota
 * is twenty messages per **Tehran calendar day** because it is a promise about
 * a person's calendar, so it needs a calendar.
 *
 * The distinction is not pedantry in this domain, because the referral domain
 * contains **both kinds** and they are one story apart. `V32-DEC-019`'s
 * referrer cap is *10 qualified referrals per **Tehran calendar month***, and it
 * belongs to Story #12. `V32-DEC-017`'s 90-day pending expiry is a duration, and
 * it belongs here. Implementing the second with a calendar would make "90 days"
 * mean something subtly different for a claim recorded at 23:00 than for one at
 * 01:00, and would introduce a month-length discontinuity nobody benefits from.
 *
 * So this file has no timezone, and Story #12's counter will need one. That is
 * the correct outcome, and naming it here is what stops somebody "fixing" the
 * inconsistency later by making both the same.
 */
export interface ReferralClock {
  now(): Date;
}

export const REFERRAL_CLOCK = Symbol('BEAUCLICK_REFERRAL_CLOCK');

export const systemReferralClock: ReferralClock = {
  now: () => new Date(),
};

/** One day, in milliseconds. The unit every duration below is built from. */
const DAY_MS = 86_400_000;

/**
 * The oldest `created_at` an account may have and still be eligible to claim.
 *
 * `V32-DEC-019`'s claim window, and Issue #27 states it as **account age ≤ 30
 * days** — so the boundary is **inclusive** and the caller compares with `>=`:
 *
 * ```
 * created_at >= accountAgeCutoff(now, 30)   -> eligible
 * ```
 *
 * An account created **exactly** 30 days ago to the millisecond is therefore
 * **eligible**. That is the reading Issue #27's `≤` requires, and both sides of
 * that millisecond are tested with a frozen clock — because "≤ 30 days"
 * implemented as `<` is the single most likely way this rule goes wrong, and it
 * would go wrong for exactly one customer per boundary rather than visibly for
 * everyone.
 *
 * An absolute UTC duration, not a calendar subtraction: `setUTCDate(-30)` would
 * make the window's length depend on which month it started in.
 */
export function accountAgeCutoff(now: Date, maxAgeDays: number): Date {
  return new Date(now.getTime() - maxAgeDays * DAY_MS);
}

/**
 * When a pending attribution formed at `attributedAt` lapses.
 *
 * `V32-DEC-017` fixes it at **90 days**, as an **absolute UTC duration**.
 *
 * Computed from the SAME instant the row's `attributed_at` is written from, so
 * the 90-day relationship between the two columns is exact rather than
 * approximately exact. A second reading of the clock — or `now()` in SQL for one
 * of the two — would make them differ by however long the transaction took, and
 * the difference would be invisible in every test that did not measure it.
 *
 * Deliberately not `setUTCMonth(+3)`: three calendar months is between 89 and 92
 * days depending on where it starts, and `V32-DEC-017` says 90 days.
 */
export function pendingAttributionExpiry(attributedAt: Date, expiryDays: number): Date {
  return new Date(attributedAt.getTime() + expiryDays * DAY_MS);
}

/**
 * The start of the UTC hour an instant falls in.
 *
 * The bucket key for `referral.claim_attempts`. Bucketing rather than a rolling
 * window is a contention decision, exactly as `minuteBucket` records for
 * `chat.send_counters`: one counter row per user, rewritten on every attempt,
 * becomes the hottest row in the schema and serialises every claimant against
 * every other. Bucketing by hour means concurrent claimants in different hours
 * touch different rows, and the conditional increment only ever serialises
 * claimants inside the same hour — which is precisely the set the limit is
 * about.
 *
 * The cost is the standard fixed-window one: a caller may make 10 attempts at
 * 10:59 and 10 more at 11:00. That is accepted rather than overlooked — at a
 * guess rate of 20 per hour in the worst case, `V32-DEC-034`'s exhaustive
 * search still runs to billions of years, so the bound the decision priced the
 * code length against survives the approximation by nine orders of magnitude.
 */
export function hourBucket(instant: Date): Date {
  const bucket = new Date(instant.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}
