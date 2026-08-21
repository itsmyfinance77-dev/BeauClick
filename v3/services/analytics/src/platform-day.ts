/**
 * The platform's operating timezone, for calendar-day bucketing.
 *
 * Duplicated deliberately rather than imported from booking-service: analytics
 * may not depend on another domain (ADR-011, enforced by lint), and the
 * alternative -- promoting a timezone constant into a shared lib -- would make
 * two unrelated domains share a deployment-coupled value for the sake of one
 * string. booking-service's `platform-time.ts` carries the full wall-clock
 * conversion machinery it needs for slot generation; analytics needs only the
 * calendar day, which is the whole of this file.
 */
export const PLATFORM_TIMEZONE = 'Asia/Tehran';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLATFORM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The calendar day an instant falls on, in the platform timezone, as
 * `YYYY-MM-DD`.
 *
 * Computed at INGEST time and stored, rather than derived in each query.
 * Deriving it per query would mean `DATE(occurred_at AT TIME ZONE
 * 'Asia/Tehran')` in every GROUP BY -- an expression no plain index can
 * serve, turning every dashboard into a full scan of the fact table.
 *
 * Bucketing in the platform zone rather than UTC is what makes the numbers
 * mean what an operator in Tehran expects: a booking completed at 02:00
 * Tehran belongs to that Tehran day, not to the previous UTC one. V2 got
 * this right by accident -- its `created_at` was already local wall clock --
 * and V3 stores timestamptz properly, so the conversion has to be explicit.
 *
 * `en-CA` is used because its short date format is ISO-ordered
 * (`YYYY-MM-DD`), which is exactly the shape a PostgreSQL `date` column
 * accepts -- avoiding a manual part-reassembly step and the off-by-one
 * padding bugs that come with it.
 */
export function platformCalendarDay(instant: Date): string {
  return dayFormatter.format(instant);
}

/** Today's calendar day in the platform timezone. */
export function platformToday(): string {
  return platformCalendarDay(new Date());
}

/** Shifts a `YYYY-MM-DD` day string by whole days, staying in calendar space. */
export function addDays(day: string, delta: number): string {
  // Parsed as UTC midnight and shifted in UTC on purpose: this is pure
  // calendar arithmetic on a date string, so involving a timezone here would
  // reintroduce the DST-style off-by-one the string form exists to avoid.
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Normalizes a requested reporting range into two safe day strings.
 *
 * Defaults to the last 30 days, swaps a reversed range, and CLAMPS the window
 * to 366 days. The clamp is load-bearing rather than tidy: without it, a
 * mistyped or adversarial `from=0001-01-01` turns every metric query into an
 * unbounded scan of the whole fact table. V2 applied the same clamp for the
 * same reason.
 */
export function normalizeRange(from?: string, to?: string): { from: string; to: string } {
  const today = platformToday();
  const isDay = (v?: string): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

  let start = isDay(from) ? from : addDays(today, -29);
  let end = isDay(to) ? to : today;

  if (start > end) [start, end] = [end, start];

  const maxDays = 366;
  if (Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) > maxDays) {
    start = addDays(end, -maxDays);
  }

  return { from: start, to: end };
}
