/**
 * Persian-locale formatting helpers. Ported verbatim from BeauClick V2
 * (app/src/lib/format.ts) per V3_MIGRATION_MATRIX.md's DIRECT REUSE
 * classification. Prices, ratings, and counts render in Persian digits
 * (۰–۹) everywhere — this is the single implementation every V3 surface
 * (backend-rendered and frontend) should import rather than each rolling
 * its own digit-swap.
 *
 * Dates: BeauClick is Persian-first/RTL-first — every user-facing date
 * uses the Jalali (Solar Hijri) calendar, never Gregorian, via jalali.ts's
 * conversion. Digit glyph substitution alone (toPersianDigits on a
 * Gregorian day/month number) is NOT calendar conversion and must never be
 * mistaken for one — this was a real, fixed bug in V2's own version of this
 * file, preserved here as a regression test (format.spec.ts).
 */

import { formatZonedFullDate, formatZonedShortDate, formatZonedTime } from './zoned';

export { normalizeDigits, toPersianDigits } from './digits';
import { toPersianDigits } from './digits';

/** Tomans, grouped by thousands, rendered in Persian digits — e.g. 350000 -> "۳۵۰٬۰۰۰". */
export function formatToman( amount: number ): string {
	const grouped = new Intl.NumberFormat( 'en-US' ).format( Math.round( amount ) ).replace( /,/g, '٬' );
	return toPersianDigits( grouped );
}

export function formatRating( rating: number ): string {
	return toPersianDigits( rating.toFixed( 1 ) );
}

export function formatCount( count: number ): string {
	return toPersianDigits( count );
}

/**
 * THE TIMEZONE RULE for every date this package formats, stated once.
 *
 * These three helpers used to read a `Date` through `getFullYear()` /
 * `getDate()` / `getHours()`, which resolve in whatever timezone the browser
 * or server process happens to be running in. That was recorded as a
 * deliberate choice and it was correct for exactly one situation: a user in
 * Iran on a machine set to Iran.
 *
 * It was wrong everywhere else, and `R31-09` recorded it as a latent bug in
 * the customer surfaces. Phase G found it is not latent. `notification-
 * analytics.handlers.ts` builds the `date` and `time` variables of the
 * booking-confirmed, booking-cancelled, and booking-rescheduled notifications
 * with `formatFullJalaliDate` and `formatTime` -- SERVER-side, in the API
 * process, where nothing sets `TZ`. On the ordinary UTC host a container runs
 * on, every customer was being told an appointment time three and a half hours
 * earlier than their actual appointment, and the wrong DAY whenever the
 * appointment fell before 03:30 Tehran. That is not a display inconsistency;
 * it is telling somebody the wrong time to turn up.
 *
 * So the platform zone is now the default rather than an opt-in. Every instant
 * this platform stores is materialized from an `Asia/Tehran` wall clock
 * (`services/booking/src/availability/platform-time.ts`), so the zone the
 * process runs in was never a meaningful input -- reading it was the defect,
 * not a feature these functions offered.
 *
 * The implementation is `zoned.ts` rather than a second copy of it: IANA rules
 * via `Intl`, never a hardcoded +03:30, because Iran abolished DST in 2022 and
 * that policy can be reversed. `timeZone` remains a parameter for the rare
 * caller that genuinely means a different zone; it is not how correctness is
 * achieved.
 */

/** Weekday name + Jalali day-of-month + Jalali month name, read in the platform timezone. */
export function formatShortDate(
	date: Date,
	timeZone?: string,
): { weekday: string; day: string; month: string } {
	return formatZonedShortDate( date, timeZone );
}

/** Complete "چهارشنبه، ۲۲ مرداد ۱۴۰۵" — for surfaces that need the year. */
export function formatFullJalaliDate( date: Date, timeZone?: string ): string {
	return formatZonedFullDate( date, timeZone );
}

/** "۰۹:۳۰", read in the platform timezone. */
export function formatTime( date: Date, timeZone?: string ): string {
	return formatZonedTime( date, timeZone );
}
