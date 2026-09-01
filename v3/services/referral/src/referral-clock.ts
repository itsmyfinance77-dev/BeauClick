import { toJalali, wallClockIn } from '@beauclick/persian-utils';

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
 * referrer cap is *10 qualified referrals per **Solar Hijri calendar month***
 * (`V32-DEC-035`), and it belongs to Story #12. `V32-DEC-017`'s 90-day pending expiry is a duration, and
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

/**
 * The SOLAR HIJRI (Jalali) calendar month an instant falls in, read in
 * `Asia/Tehran`, as an ASCII `YYYY-MM` key such as `1405-06`.
 *
 * The bucket key for `referral.referrer_counters` — `V32-DEC-019`'s **10
 * qualified referrals per referrer per **Solar Hijri calendar month**, ratified
 * as `V32-DEC-035`.
 *
 * ## The calendar is Jalali, and this was decided rather than inherited
 *
 * `V32-DEC-019` said "Tehran calendar month" without naming a calendar.
 * `ADR-037` §7 flagged the ambiguity instead of presenting its Gregorian
 * reading as settled, and the owner **ratified the Solar Hijri (Jalali) month
 * on 2026-09-01** — so this returns a **Jalali** year and month, and a
 * Gregorian month evaluated in Tehran is explicitly *not* the policy.
 *
 * The two readings are not a rounding difference. A Jalali month begins around
 * the 21st of a Gregorian one, so "when does my allowance reset" had two
 * answers roughly **three weeks apart, every month, forever**.
 *
 * **`ai`'s `tehranCalendarDay` is not a precedent for the other reading**,
 * which is the trap this correction came out of: for a **day**, Gregorian and
 * Jalali are the *same window* and only the label differs. The question a
 * **month** asks had never been exercised anywhere in this codebase.
 *
 * ## Three separable concerns, and conflating any two is how this goes wrong
 *
 * | Concern | Mechanism | Must not |
 * |---|---|---|
 * | the **instant** | a `Date`, UTC | acquire a calendar |
 * | the **timezone** | `wallClockIn(instant, 'Asia/Tehran')` | hardcode +03:30 |
 * | the **calendar** | `toJalali(gy, gm, gd)` | know about zones |
 *
 * Read strictly in that order. An implementation that skipped the timezone
 * would bucket by UTC and push every late-evening Tehran qualification into the
 * wrong month; one that skipped the calendar is the Gregorian behaviour this
 * replaces.
 *
 * **The period begins at 00:00 `Asia/Tehran`**, which is currently 20:30 UTC on
 * the preceding day. That offset is **read from the IANA database at the
 * instant in question** — `wallClockIn` uses `formatToParts` under the hood —
 * rather than hardcoded, because Iran abolished DST in 2022 and could resume
 * it, and a fixed offset would be right today and silently an hour wrong for
 * the affected days.
 *
 * ## Why this adds no dependency
 *
 * `@beauclick/persian-utils` is already the platform's single Jalali
 * implementation and is `scope:shared` with four services already depending on
 * it. `toJalali` is **pure arithmetic** — the public-domain 2820-year-cycle
 * algorithm routed through Julian Day Numbers, verified in `jalali.spec.ts`
 * against the 1979-02-11 ↔ 1357-11-22 reference point — so calendar
 * correctness does **not** depend on the container's ICU build.
 *
 * An `Intl.DateTimeFormat` with `calendar: 'persian'` would have been the
 * obvious alternative and was rejected for exactly that reason: it makes a
 * payout window depend on which ICU data the production image happens to ship,
 * and a small-ICU build would silently fall back to a Gregorian answer that
 * looks perfectly well-formed.
 *
 * ## Fail closed
 *
 * The result is validated against the same shape the database enforces
 * (`ck_referrer_counters_period_format`). A malformed or non-ASCII value throws
 * rather than being written: a period key is the bucket a payout limit is
 * counted in, and a silently wrong one would create a parallel window nothing
 * ever caps.
 */
export function tehranCalendarMonth(instant: Date): string {
  // 1. The instant, read as a wall clock in Tehran. IANA offset, via
  //    `formatToParts` with an `en-US` locale -- so the parts are ASCII digits
  //    rather than a locale's own numbering system.
  const wall = wallClockIn(instant, REFERRAL_CAP_TIME_ZONE);

  // 2. That Gregorian wall-clock DATE, converted to Jalali. Pure arithmetic;
  //    no zone, no locale, no ICU.
  const { jy, jm } = toJalali(wall.year, wall.month, wall.day);

  const period = `${jy}-${String(jm).padStart(2, '0')}`;

  // 3. Fail closed. Not defensive decoration: `jy` outside four digits or `jm`
  //    outside 1..12 would violate the database CHECK and be rejected at INSERT
  //    time -- during a qualification, in production, on the first day of a
  //    month. Throwing here fails the same transaction one statement earlier
  //    with a message that says which value was wrong.
  if (!REFERRAL_PERIOD_KEY_PATTERN.test(period)) {
    throw new Error(
      `Referral cap period key is malformed: expected a Jalali YYYY-MM with ASCII digits, computed "${period}" ` +
        `from Tehran wall clock ${wall.year}-${wall.month}-${wall.day}.`,
    );
  }

  return period;
}

/**
 * The platform timezone the cap is evaluated in — `V32-DEC-035`.
 *
 * Named here rather than inlined because it is a **ratified parameter**, and a
 * reader looking for it should find a constant rather than a string literal
 * inside a function call.
 */
export const REFERRAL_CAP_TIME_ZONE = 'Asia/Tehran';

/**
 * The shape a period key must have, identical to
 * `ck_referrer_counters_period_format` in the migration.
 *
 * Duplicated deliberately rather than derived: the database constraint is the
 * real guarantee, and this one exists so a malformed key fails in the
 * application with a diagnosable message instead of as a constraint violation
 * mid-transaction. Two copies of a regex that must agree is a real cost, and
 * the suite asserts they do.
 */
export const REFERRAL_PERIOD_KEY_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
