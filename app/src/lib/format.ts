/**
 * Persian-locale formatting helpers. Per the design handoff, prices,
 * ratings, and counts render in Persian digits (۰–۹) everywhere — this is
 * the single implementation both the marketplace, booking, cart, and
 * dashboard surfaces should import rather than each rolling their own
 * digit-swap, so the rule can't silently regress in one surface.
 *
 * Dates: BeauClick is Persian-first/RTL-first — every user-facing date
 * uses the Jalali (Solar Hijri) calendar, never Gregorian, via jalali.ts's
 * conversion (see that file for the algorithm/correctness notes). Digit
 * glyph substitution alone (toPersianDigits on a Gregorian day/month
 * number) is NOT calendar conversion and must never be mistaken for one —
 * this was a real, now-fixed bug in this exact file (formatShortDate used
 * to return the Gregorian day-of-month/month-number with Persian digits,
 * not an actual Jalali date).
 */

import { JALALI_MONTHS, toJalali } from './jalali';

const PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

export function toPersianDigits( input: string | number ): string {
	return String( input ).replace( /[0-9]/g, ( d ) => PERSIAN_DIGITS[ Number( d ) ] );
}

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

const PERSIAN_WEEKDAYS = [ 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه' ];

/**
 * Weekday name + Jalali day-of-month + Jalali month name, used by the
 * booking date-chip picker and every dashboard/table date display.
 * `date.getDay()`/`getFullYear()`/`getMonth()`/`getDate()` (not the UTC
 * variants) deliberately read the Date object in the browser's own local
 * time — the same assumption every existing caller already relies on when
 * constructing these Date objects from a site-local MySQL datetime string
 * (e.g. `new Date(row.slotStart.replace(' ', 'T'))`), so this doesn't
 * change that behavior, only which calendar the day/month are read from.
 */
export function formatShortDate( date: Date ): { weekday: string; day: string; month: string } {
	const { jm, jd } = toJalali( date.getFullYear(), date.getMonth() + 1, date.getDate() );
	return {
		weekday: PERSIAN_WEEKDAYS[ date.getDay() ],
		day: toPersianDigits( jd ),
		month: JALALI_MONTHS[ jm - 1 ],
	};
}

/** Complete "چهارشنبه، ۲۲ مرداد ۱۴۰۵" — for surfaces that need the year, not just a short chip label (order/booking history tables, journey timeline, goal target dates). */
export function formatFullJalaliDate( date: Date ): string {
	const { jy, jm, jd } = toJalali( date.getFullYear(), date.getMonth() + 1, date.getDate() );
	const weekday = PERSIAN_WEEKDAYS[ date.getDay() ];
	return `${ weekday }، ${ toPersianDigits( jd ) } ${ JALALI_MONTHS[ jm - 1 ] } ${ toPersianDigits( jy ) }`;
}

export function formatTime( date: Date ): string {
	const hours = date.getHours().toString().padStart( 2, '0' );
	const minutes = date.getMinutes().toString().padStart( 2, '0' );
	return toPersianDigits( `${ hours }:${ minutes }` );
}
