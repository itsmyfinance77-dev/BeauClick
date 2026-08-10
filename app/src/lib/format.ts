/**
 * Persian-locale formatting helpers. Per the design handoff, prices,
 * ratings, and counts render in Persian digits (۰–۹) everywhere — this is
 * the single implementation both the marketplace, booking, cart, and
 * dashboard surfaces should import rather than each rolling their own
 * digit-swap, so the rule can't silently regress in one surface.
 */

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

/** Short weekday + Gregorian day/month in Persian digits, used by the booking date-chip picker. */
export function formatShortDate( date: Date ): { weekday: string; day: string; month: string } {
	return {
		weekday: PERSIAN_WEEKDAYS[ date.getDay() ],
		day: toPersianDigits( date.getDate() ),
		month: toPersianDigits( date.getMonth() + 1 ),
	};
}

export function formatTime( date: Date ): string {
	const hours = date.getHours().toString().padStart( 2, '0' );
	const minutes = date.getMinutes().toString().padStart( 2, '0' );
	return toPersianDigits( `${ hours }:${ minutes }` );
}
