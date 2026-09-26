import {
  PLATFORM_TIMEZONE,
  toGregorian,
  toJalali,
  wallClockIn,
  zonedDateTimeToInstant,
} from '@beauclick/persian-utils';

/**
 * The months a finance workspace's settlement series is counted in (#255).
 *
 * ## A month is a SOLAR HIJRI (Jalali) calendar month, in `Asia/Tehran`
 *
 * Not a Gregorian month, and not a Gregorian month evaluated in Tehran. The
 * owner ratified the Jalali month as what "calendar month" means on this
 * platform (`V32-DEC-035`, 2026-09-01, for the referral cap), and every date
 * the finance pages render is already Jalali and Tehran's. A Gregorian bucket
 * would begin around the 21st of the Jalali month the page names, so the
 * figure under «تیر» would be half Khordad -- three weeks off, every month.
 *
 * The same three concerns `referral-clock.ts`'s `solarHijriMonthKey` keeps
 * apart, in the same order:
 *
 * | Concern | Mechanism |
 * |---|---|
 * | the instant | a `Date`, UTC |
 * | the timezone | `wallClockIn` / `zonedDateTimeToInstant`, `PLATFORM_TIMEZONE` |
 * | the calendar | `toJalali` / `toGregorian`, pure arithmetic |
 *
 * **A month begins at 00:00 Tehran on its 1st** -- currently 20:30 UTC on the
 * previous Gregorian day. The offset is read from the IANA database at that
 * instant, never hardcoded: Iran kept +04:30 summer time until 2022.
 *
 * Windows are half-open, `[startsAt, endsAt)`: the next month's start is this
 * month's end, so an instant belongs to exactly one month.
 */
export interface SettlementMonthWindow {
  /** ASCII `YYYY-MM`, Jalali, e.g. `1405-06`. */
  month: string;
  startsAt: Date;
  endsAt: Date;
}

/** Instant at which Jalali month `jm` of year `jy` begins in Tehran. */
export function jalaliMonthStart(jy: number, jm: number): Date {
  const { gy, gm, gd } = toGregorian(jy, jm, 1);
  const isoDate = `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  return zonedDateTimeToInstant(isoDate, '00:00', PLATFORM_TIMEZONE);
}

function shift(jy: number, jm: number, months: number): { jy: number; jm: number } {
  const index = jy * 12 + (jm - 1) + months;
  return { jy: Math.floor(index / 12), jm: (index % 12) + 1 };
}

/**
 * The `count` Jalali months ending with the one `now` falls in, oldest first.
 *
 * The last window is the CURRENT month: its `endsAt` is in the future, and a
 * reader must say it is not over (`endsAt > now`), not present it as a whole
 * month.
 */
export function settlementMonthWindows(now: Date, count: number): SettlementMonthWindow[] {
  const wall = wallClockIn(now, PLATFORM_TIMEZONE);
  const current = toJalali(wall.year, wall.month, wall.day);

  const windows: SettlementMonthWindow[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const { jy, jm } = shift(current.jy, current.jm, -back);
    const next = shift(jy, jm, 1);
    windows.push({
      month: `${String(jy).padStart(4, '0')}-${String(jm).padStart(2, '0')}`,
      startsAt: jalaliMonthStart(jy, jm),
      endsAt: jalaliMonthStart(next.jy, next.jm),
    });
  }
  return windows;
}
