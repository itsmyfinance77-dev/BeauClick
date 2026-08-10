import { describe, expect, it } from 'vitest';
import { formatCount, formatRating, formatToman, toPersianDigits } from './format';

describe( 'toPersianDigits', () => {
	it( 'converts every ASCII digit to its Persian equivalent', () => {
		expect( toPersianDigits( '0123456789' ) ).toBe( '۰۱۲۳۴۵۶۷۸۹' );
	} );

	it( 'leaves non-digit characters untouched', () => {
		expect( toPersianDigits( 'یزد 350' ) ).toBe( 'یزد ۳۵۰' );
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
