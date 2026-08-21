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

import { JALALI_MONTHS, toJalali } from './jalali';

const PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

export function toPersianDigits( input: string | number ): string {
	return String( input ).replace( /[0-9]/g, ( d ) => PERSIAN_DIGITS[ Number( d ) ] );
}

/**
 * The inverse of `toPersianDigits`: Persian (۰–۹, U+06F0–U+06F9) and
 * Arabic-Indic (٠–٩, U+0660–U+0669) digits folded to ASCII.
 *
 * Added in Phase 3 for the input direction. Every number a Persian-speaking
 * user types — a price filter, a page number, a budget — arrives in Persian
 * digits, and `Number('۵۰۰')` is `NaN`. Without this, a perfectly valid
 * filter is rejected as malformed, which reads to the user as the feature
 * being broken.
 *
 * BOTH digit ranges are folded, not just the Persian one: Arabic-Indic
 * digits arrive from Arabic-locale keyboards and mobile IMEs that Persian
 * speakers genuinely use, and V2's own search normalizer had exactly this
 * pair for exactly that reason.
 *
 * Note the asymmetry with `toPersianDigits`, which is deliberate: output is
 * always Persian, input accepts anything. A user must never have to know
 * which numeral system the system prefers.
 */
export function normalizeDigits( input: string ): string {
	return input.replace( /[۰-۹٠-٩]/g, ( d ) => {
		const code = d.charCodeAt( 0 );
		const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
		return String( code - base );
	} );
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
 * Weekday name + Jalali day-of-month + Jalali month name, used by every
 * date-chip/table display. `date.getDay()`/`getFullYear()`/`getMonth()`/
 * `getDate()` (not the UTC variants) deliberately read the Date object in
 * the local timezone the server/browser is running in.
 */
export function formatShortDate( date: Date ): { weekday: string; day: string; month: string } {
	const { jm, jd } = toJalali( date.getFullYear(), date.getMonth() + 1, date.getDate() );
	return {
		weekday: PERSIAN_WEEKDAYS[ date.getDay() ],
		day: toPersianDigits( jd ),
		month: JALALI_MONTHS[ jm - 1 ],
	};
}

/** Complete "چهارشنبه، ۲۲ مرداد ۱۴۰۵" — for surfaces that need the year. */
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
