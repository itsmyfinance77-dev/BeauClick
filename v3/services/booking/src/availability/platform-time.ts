/**
 * Wall-clock <-> instant conversion for the platform's operating timezone.
 *
 * Why this exists: a professional publishes availability in *local wall
 * clock* terms ("Saturdays and Mondays, 09:00 to 17:00"), but a slot must
 * be stored as a real instant (`timestamptz`) so that claiming, expiry, and
 * ordering are unambiguous. Converting between the two is the one place a
 * timezone genuinely enters this domain, so it is isolated here rather than
 * smeared across the availability service.
 *
 * Implemented with `Intl.DateTimeFormat`'s IANA database rather than a
 * hard-coded +03:30 offset. Iran abolished DST in 2022, so a fixed offset
 * would be correct *today* -- and would silently produce one-hour-wrong
 * slots for every affected day if that policy is ever reversed. Reading the
 * real zone rules costs ~20 lines and removes that whole failure mode.
 */
export const PLATFORM_TIMEZONE = 'Asia/Tehran';

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = partsFormatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, cached);
  }
  return cached;
}

/** The wall-clock reading a person in `timeZone` would see at this instant. */
export function wallClockPartsIn(instant: Date, timeZone: string = PLATFORM_TIMEZONE): WallClockParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's UTC offset, in minutes, at a given instant. Positive east of Greenwich. */
export function zoneOffsetMinutes(instant: Date, timeZone: string = PLATFORM_TIMEZONE): number {
  const p = wallClockPartsIn(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/**
 * Converts a local wall-clock date+time in `timeZone` into the real instant.
 *
 * Two passes, not one: the offset can only be looked up FOR an instant, and
 * the instant is what we are trying to find. The first pass guesses using
 * the offset at the naive-UTC reading; the second re-reads the offset at
 * that candidate and corrects. Two passes converge for every real zone rule
 * (offsets change by at most a couple of hours, far less than the day-scale
 * error a single pass could leave near a transition).
 */
export function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(naiveUtc - zoneOffsetMinutes(new Date(naiveUtc), timeZone) * 60_000);
  candidate = new Date(naiveUtc - zoneOffsetMinutes(candidate, timeZone) * 60_000);
  return candidate;
}

/** `YYYY-MM-DD` + `HH:mm`, both in `timeZone`, to a real instant. */
export function localDateTimeToInstant(
  isoDate: string,
  isoTime: string,
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = isoTime.split(':').map(Number);
  return wallClockToInstant(y, m, d, hh, mm, timeZone);
}

/**
 * Day of week (0=Sunday .. 6=Saturday) as seen in `timeZone`, matching the
 * convention V2's `bulk_generate` already used and every V3 client
 * therefore already speaks. Deliberately not `Date#getDay()`, which reads
 * the SERVER's timezone -- a server in UTC would classify a Saturday 00:30
 * Tehran slot as Friday.
 */
export function zonedWeekday(instant: Date, timeZone: string = PLATFORM_TIMEZONE): number {
  const p = wallClockPartsIn(instant, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isIsoTime(value: string): boolean {
  if (!ISO_TIME.test(value)) return false;
  const [h, m] = value.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
