import { formatCount, formatFullJalaliDate, formatRating, formatShortDate, formatTime, formatToman, toPersianDigits } from './format';

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

describe( 'formatShortDate (Jalali)', () => {
	it( 'returns the Jalali day and month name for the well-known Nowruz reference, not the Gregorian one', () => {
		// 2024-03-20 Gregorian = 1403-01-01 Jalali (Nowruz).
		const { day, month } = formatShortDate( new Date( 2024, 2, 20 ) ); // JS month is 0-indexed -> March
		expect( day ).toBe( '۱' );
		expect( month ).toBe( 'فروردین' );
	} );

	it( 'never returns a Gregorian month number where a Jalali month name belongs (the fixed V2 bug, preserved as a regression test)', () => {
		const { month } = formatShortDate( new Date( 2026, 7, 12 ) ); // August 12, 2026
		expect( [ 'مرداد', 'شهریور' ] ).toContain( month );
		expect( month ).not.toMatch( /^\d/ );
	} );

	it( 'computes the correct Persian weekday name', () => {
		const { weekday } = formatShortDate( new Date( 2024, 2, 20 ) );
		expect( weekday ).toBe( 'چهارشنبه' );
	} );
} );

describe( 'formatFullJalaliDate', () => {
	it( 'combines weekday, Jalali day, Jalali month name, and Jalali year into one Persian string', () => {
		const result = formatFullJalaliDate( new Date( 2024, 2, 20 ) );
		expect( result ).toBe( 'چهارشنبه، ۱ فروردین ۱۴۰۳' );
	} );
} );

describe( 'formatTime', () => {
	it( 'formats HH:mm in Persian digits, independent of calendar system', () => {
		const date = new Date( 2026, 7, 12, 9, 5 );
		expect( formatTime( date ) ).toBe( '۰۹:۰۵' );
	} );
} );
