import { formatCount, formatFullJalaliDate, formatRating, formatShortDate, formatTime, formatToman, normalizeDigits, toPersianDigits } from './format';

describe( 'toPersianDigits', () => {
	it( 'converts every ASCII digit to its Persian equivalent', () => {
		expect( toPersianDigits( '0123456789' ) ).toBe( '۰۱۲۳۴۵۶۷۸۹' );
	} );

	it( 'leaves non-digit characters untouched', () => {
		expect( toPersianDigits( 'یزد 350' ) ).toBe( 'یزد ۳۵۰' );
	} );

	it( 'swaps ASCII digits for Persian glyphs', () => {
		expect( toPersianDigits( 1403 ) ).toBe( '۱۴۰۳' );
		expect( toPersianDigits( '2026-08-12' ) ).toBe( '۲۰۲۶-۰۸-۱۲' );
	} );
} );

describe( 'formatToman', () => {
	it( 'groups thousands with the Persian separator and Persian digits', () => {
		expect( formatToman( 350000 ) ).toBe( '۳۵۰٬۰۰۰' );
	} );

	it( 'rounds fractional amounts before formatting', () => {
		expect( formatToman( 1999.6 ) ).toBe( '۲٬۰۰۰' );
	} );
} );

describe( 'formatRating', () => {
	it( 'renders one decimal place in Persian digits', () => {
		expect( formatRating( 4.8 ) ).toBe( '۴.۸' );
	} );
} );

describe( 'formatCount', () => {
	it( 'renders an integer count in Persian digits', () => {
		expect( formatCount( 126 ) ).toBe( '۱۲۶' );
	} );
} );

/**
 * The date helpers read the PLATFORM timezone, not the host's (`R31-09`).
 *
 * Every case below therefore names an absolute instant -- `Date.UTC(...)` --
 * rather than `new Date(y, m, d)`, which builds an instant from whatever zone
 * the test runner happens to sit in. That is not a stylistic preference: the
 * previous versions of these cases used the local-time constructor and passed
 * on a machine set to Iran while asserting something different on the UTC host
 * CI runs on. A test whose expected value depends on the runner's clock is not
 * testing the function.
 */
describe( 'formatShortDate (Jalali, platform timezone)', () => {
	it( 'returns the Jalali day and month name for the well-known Nowruz reference, not the Gregorian one', () => {
		// 2024-03-20 12:00 UTC = 15:30 Tehran, same day = 1403-01-01 Jalali (Nowruz).
		const { day, month } = formatShortDate( new Date( Date.UTC( 2024, 2, 20, 12, 0 ) ) );
		expect( day ).toBe( '۱' );
		expect( month ).toBe( 'فروردین' );
	} );

	it( 'never returns a Gregorian month number where a Jalali month name belongs (the fixed V2 bug, preserved as a regression test)', () => {
		const { month } = formatShortDate( new Date( Date.UTC( 2026, 7, 12, 12, 0 ) ) );
		expect( [ 'مرداد', 'شهریور' ] ).toContain( month );
		expect( month ).not.toMatch( /^\d/ );
	} );

	it( 'computes the correct Persian weekday name', () => {
		const { weekday } = formatShortDate( new Date( Date.UTC( 2024, 2, 20, 12, 0 ) ) );
		expect( weekday ).toBe( 'چهارشنبه' );
	} );
} );

describe( 'formatFullJalaliDate', () => {
	it( 'combines weekday, Jalali day, Jalali month name, and Jalali year into one Persian string', () => {
		const result = formatFullJalaliDate( new Date( Date.UTC( 2024, 2, 20, 12, 0 ) ) );
		expect( result ).toBe( 'چهارشنبه، ۱ فروردین ۱۴۰۳' );
	} );
} );

describe( 'formatTime', () => {
	it( 'formats HH:mm in Persian digits, independent of calendar system', () => {
		// 05:35 UTC is exactly 09:05 in Asia/Tehran (+03:30, no DST since 2022).
		expect( formatTime( new Date( Date.UTC( 2026, 7, 12, 5, 35 ) ) ) ).toBe( '۰۹:۰۵' );
	} );
} );

/**
 * The R31-09 regression cases.
 *
 * Each one is chosen so that reading the instant in the HOST timezone gives a
 * different answer from reading it in `Asia/Tehran` for every host CI or a
 * developer might plausibly use. If these three pass, the helpers are not
 * consulting the ambient clock.
 */
describe( 'R31-09 — dates are read in the platform timezone, never the host one', () => {
	it( 'reports the Tehran hour for an instant, not the UTC one', () => {
		// 21:00 UTC on the 11th is 00:30 Tehran on the 12th.
		expect( formatTime( new Date( Date.UTC( 2026, 7, 11, 21, 0 ) ) ) ).toBe( '۰۰:۳۰' );
	} );

	it( 'assigns a late-evening UTC instant to the NEXT Jalali day, as Tehran sees it', () => {
		// The date rolls over in Tehran three and a half hours before it does in UTC,
		// so this instant is the 12th in Tehran and still the 11th in UTC.
		const utcEleventh = formatFullJalaliDate( new Date( Date.UTC( 2026, 7, 11, 21, 0 ) ) );
		const tehranTwelfth = formatFullJalaliDate( new Date( Date.UTC( 2026, 7, 12, 12, 0 ) ) );
		expect( utcEleventh ).toBe( tehranTwelfth );
	} );

	it( 'is unaffected by the host clock, proven by agreeing with an explicit Asia/Tehran request', () => {
		const instant = new Date( Date.UTC( 2026, 7, 11, 21, 0 ) );
		expect( formatFullJalaliDate( instant ) ).toBe( formatFullJalaliDate( instant, 'Asia/Tehran' ) );
		expect( formatTime( instant ) ).toBe( formatTime( instant, 'Asia/Tehran' ) );
		// ...and genuinely differs from what a UTC reading would produce, so the
		// assertion above is not trivially true.
		expect( formatTime( instant ) ).not.toBe( formatTime( instant, 'UTC' ) );
	} );
} );

describe( 'normalizeDigits (Phase 3 — the input direction)', () => {
	it( 'folds Persian digits to ASCII so a typed number is a number', () => {
		// Without this, Number('۵۰۰') is NaN and a perfectly valid price filter
		// is rejected as malformed — which reads to the user as a broken feature.
		expect( normalizeDigits( '۵۰۰۰۰۰' ) ).toBe( '500000' );
		expect( Number( normalizeDigits( '۵۰۰۰۰۰' ) ) ).toBe( 500000 );
	} );

	it( 'folds Arabic-Indic digits too', () => {
		// Arabic-locale keyboards and mobile IMEs that Persian speakers
		// genuinely use emit this range, not the Persian one.
		expect( normalizeDigits( '٤٥٦' ) ).toBe( '456' );
	} );

	it( 'handles a mixed-numeral string', () => {
		expect( normalizeDigits( '۱٢3' ) ).toBe( '123' );
	} );

	it( 'leaves ASCII digits and non-digits untouched', () => {
		expect( normalizeDigits( 'abc 123 سلام' ) ).toBe( 'abc 123 سلام' );
	} );

	it( 'round-trips with toPersianDigits', () => {
		expect( normalizeDigits( toPersianDigits( '2026-08-20' ) ) ).toBe( '2026-08-20' );
	} );

	it( 'is asymmetric on purpose: output is always Persian, input accepts anything', () => {
		// A user must never have to know which numeral system the system prefers.
		expect( toPersianDigits( normalizeDigits( '٤٥٦' ) ) ).toBe( '۴۵۶' );
	} );
} );
