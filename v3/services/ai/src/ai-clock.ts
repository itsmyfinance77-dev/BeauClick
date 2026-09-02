/**
 * The injected clock, and the Tehran calendar day.
 *
 * ## Why a clock port at all
 *
 * Three of this module's rules are time: a conversation closes after 24 hours
 * of inactivity, a conversation is destroyed after 30 days, and a quota resets
 * at a Tehran calendar boundary (`V32-DEC-002`, `V32-DEC-007`, `V32-DEC-008`).
 *
 * A rule that reads `new Date()` directly is a rule that can only be tested by
 * waiting, or by writing rows with fabricated timestamps and hoping the
 * fabrication matches what production would have produced. Both are how a
 * boundary condition ends up unproved — and the boundary conditions are exactly
 * what a retention policy is: 30 days is trivially right at day 3 and at day
 * 300, and interesting only at day 30.
 *
 * So the clock is a port, and the real one reads the real clock. Nothing else
 * in this module calls `Date.now()`.
 *
 * ## Why the calendar day is computed here and not in SQL
 *
 * `(now() AT TIME ZONE 'Asia/Tehran')::date` in the quota statement would be
 * atomic, correct, and untestable — a suite cannot move the database's clock,
 * so the reset boundary would be a property nobody had ever exercised. Proving
 * the reset is a mandatory test.
 *
 * Computing the day here and passing it as a parameter keeps the atomicity
 * (the conditional `INSERT ... ON CONFLICT DO UPDATE` is still one statement in
 * one transaction) while making the boundary something a test can stand on
 * either side of. The trade is that a badly-skewed application clock would
 * bucket a message into the wrong day; that is a monitoring concern on every
 * host already, and a far smaller risk than an unproven reset.
 */

/** Read by everything in this module that needs to know what time it is. */
export interface AiClock {
  now(): Date;
}

export const AI_CLOCK = Symbol('BEAUCLICK_AI_CLOCK');

export const systemAiClock: AiClock = {
  now: () => new Date(),
};

/**
 * The platform's operating timezone.
 *
 * Duplicated from `analytics/platform-day.ts` deliberately, and for the reason
 * that file already records: `ai` may not depend on another domain (ADR-011,
 * enforced by lint), and promoting a timezone constant into a shared lib would
 * make unrelated domains share a deployment-coupled value for the sake of one
 * string. Analytics needed the calendar day and nothing else; so does this.
 */
export const AI_PLATFORM_TIMEZONE = 'Asia/Tehran';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: AI_PLATFORM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Tehran calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * `en-CA` because its short date format is ISO-ordered, which is exactly the
 * shape a PostgreSQL `date` column accepts — avoiding a manual part-reassembly
 * step and the off-by-one padding bugs that come with it. The same choice
 * analytics made, for the same reason.
 *
 * Tehran rather than UTC because the quota is a promise to a person: a customer
 * sending their twentieth message at 01:00 Tehran has used today's allowance,
 * not yesterday's, and telling them otherwise would be telling them something
 * that does not match the date on their own phone.
 */
export function tehranCalendarDay(instant: Date): string {
  return dayFormatter.format(instant);
}

/**
 * The instant the given Tehran day's allowance resets — midnight at the start
 * of the NEXT Tehran day, as a UTC instant.
 *
 * Returned as an absolute instant rather than a duration because that is what
 * the browser contract carries (`AiQuotaView.resetsAt`): a duration computed
 * server-side is stale by the time it renders, and a client counting down to a
 * moment it calculated in its own timezone counts down to the wrong one.
 *
 * ## Why the offset is derived rather than hardcoded
 *
 * Iran observed daylight saving until 2022 and could resume; hardcoding +03:30
 * would be correct today and silently wrong the year that changed. So the
 * offset is measured from the runtime's own IANA database at the instant in
 * question: format the target midnight as if it were UTC, ask what Tehran wall
 * clock that corresponds to, and correct by the difference. Two passes, because
 * the offset at the corrected instant can differ from the offset at the first
 * guess — which is precisely what happens on a transition night.
 */
export function tehranDayResetsAt(day: string): Date {
  // Midnight of the day AFTER `day`, expressed as a naive wall-clock instant.
  const naiveNextMidnight = new Date(`${day}T00:00:00.000Z`);
  naiveNextMidnight.setUTCDate(naiveNextMidnight.getUTCDate() + 1);

  let guess = naiveNextMidnight;
  for (let pass = 0; pass < 2; pass += 1) {
    const offsetMs = tehranOffsetMs(guess);
    const corrected = new Date(naiveNextMidnight.getTime() - offsetMs);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess;
}

/** Tehran's UTC offset in milliseconds at a given instant, read from the IANA database. */
function tehranOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AI_PLATFORM_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour` can come back as 24 for midnight under some ICU versions.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/** Whole hours between two instants. Used by the inactivity horizon. */
export function hoursBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}
