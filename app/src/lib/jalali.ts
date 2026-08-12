/**
 * Gregorian <-> Jalali (Solar Hijri) calendar conversion — pure date math,
 * no presentation concerns (see format.ts for that). This is the ONE
 * conversion implementation the whole app-shell uses; no feature should
 * hand-roll its own Jalali arithmetic.
 *
 * Algorithm: the standard 2820-year-cycle Jalali calculation (the same
 * public-domain algorithm used by jalaali-js/moment-jalaali and PHP's
 * common jalali packages, based on Kazimierz Borkowski's astronomical
 * calculation), operating via Julian Day Numbers so Gregorian<->Jalali is
 * always routed through one unambiguous intermediate representation.
 * Verified in jalali.test.ts against the well-known 1979-02-11 <->
 * 1357-11-22 reference point (Iranian Revolution Day) plus structural
 * invariants (month lengths, leap-year day counts) and round-trip
 * consistency across a wide date range.
 *
 * This module works entirely with calendar-date components (year/month/
 * day integers), never a JS Date's own timezone-sensitive internals --
 * callers are responsible for extracting the right Gregorian y/m/d first
 * (see format.ts's use of getFullYear()/getMonth()/getDate(), which read
 * the Date in the browser's local timezone, matching how WordPress's own
 * `current_time('mysql')` timestamps are already site-local, not UTC --
 * this is what avoids the off-by-one-day errors a naive UTC-based
 * conversion would introduce).
 */

function div( a: number, b: number ): number {
	return Math.trunc( a / b );
}

function mod( a: number, b: number ): number {
	return a - Math.trunc( a / b ) * b;
}

/** Years marking the boundaries of the 33-year sub-cycles within the 2820-year grand cycle. */
const BREAKS = [ -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178 ];

interface JalCal {
	leap: number;
	gy: number;
	march: number;
}

function jalCal( jy: number ): JalCal {
	const bl = BREAKS.length;
	const gy = jy + 621;
	let leapJ = -14;
	let jp = BREAKS[ 0 ];
	let jump = 0;

	for ( let i = 1; i < bl; i += 1 ) {
		const jm = BREAKS[ i ];
		jump = jm - jp;
		if ( jy < jm ) break;
		leapJ = leapJ + div( jump, 33 ) * 8 + div( mod( jump, 33 ), 4 );
		jp = jm;
	}

	let n = jy - jp;
	leapJ = leapJ + div( n, 33 ) * 8 + div( mod( n, 33 ) + 3, 4 );
	if ( mod( jump, 33 ) === 4 && jump - n === 4 ) {
		leapJ += 1;
	}

	const leapG = div( gy, 4 ) - div( ( div( gy, 100 ) + 1 ) * 3, 4 ) - 150;
	const march = 20 + leapJ - leapG;

	if ( jump - n < 6 ) {
		n = n - jump + div( jump + 4, 33 ) * 33;
	}
	let leap = mod( mod( n + 1, 33 ) - 1, 4 );
	if ( leap === -1 ) {
		leap = 4;
	}

	return { leap, gy, march };
}

function g2d( gy: number, gm: number, gd: number ): number {
	let d = div( ( gy + div( gm - 8, 6 ) + 100100 ) * 1461, 4 ) + div( 153 * mod( gm + 9, 12 ) + 2, 5 ) + gd - 34840408;
	d = d - div( div( gy + 100100 + div( gm - 8, 6 ), 100 ) * 3, 4 ) + 752;
	return d;
}

function d2g( jdn: number ): { gy: number; gm: number; gd: number } {
	let j = 4 * jdn + 139361631;
	j = j + div( div( 4 * jdn + 183187720, 146097 ) * 3, 4 ) * 4 - 3908;
	const i = div( mod( j, 1461 ), 4 ) * 5 + 308;
	const gd = div( mod( i, 153 ), 5 ) + 1;
	const gm = mod( div( i, 153 ), 12 ) + 1;
	const gy = div( j, 1461 ) - 100100 + div( 8 - gm, 6 );
	return { gy, gm, gd };
}

function j2d( jy: number, jm: number, jd: number ): number {
	const r = jalCal( jy );
	return g2d( r.gy, 3, r.march ) + ( jm - 1 ) * 31 - div( jm, 7 ) * ( jm - 7 ) + jd - 1;
}

function d2j( jdn: number ): { jy: number; jm: number; jd: number } {
	const gy = d2g( jdn ).gy;
	let jy = gy - 621;
	const r = jalCal( jy );
	const jdn1f = g2d( gy, 3, r.march );
	let k = jdn - jdn1f;

	if ( k >= 0 ) {
		if ( k <= 185 ) {
			return { jy, jm: 1 + div( k, 31 ), jd: mod( k, 31 ) + 1 };
		}
		k -= 186;
	} else {
		jy -= 1;
		k += 179;
		if ( r.leap === 1 ) {
			k += 1;
		}
	}

	return { jy, jm: 7 + div( k, 30 ), jd: mod( k, 30 ) + 1 };
}

export interface JalaliDate {
	jy: number;
	jm: number;
	jd: number;
}

export interface GregorianDate {
	gy: number;
	gm: number;
	gd: number;
}

export function toJalali( gy: number, gm: number, gd: number ): JalaliDate {
	const { jy, jm, jd } = d2j( g2d( gy, gm, gd ) );
	return { jy, jm, jd };
}

export function toGregorian( jy: number, jm: number, jd: number ): GregorianDate {
	const { gy, gm, gd } = d2g( j2d( jy, jm, jd ) );
	return { gy, gm, gd };
}

/** True for a 366-day Jalali year (leap === 0 in jalCal's own convention -- the year *starting* at jy is leap iff jalCal(jy).leap === 0). */
export function isJalaliLeapYear( jy: number ): boolean {
	return jalCal( jy ).leap === 0;
}

/** 1-indexed Jalali month (1=فروردین..12=اسفند) -> day count, leap-year aware for اسفند (month 12). */
export function jalaliMonthLength( jy: number, jm: number ): number {
	if ( jm <= 6 ) return 31;
	if ( jm <= 11 ) return 30;
	return isJalaliLeapYear( jy ) ? 30 : 29;
}

export const JALALI_MONTHS = [
	'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
	'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
