import { isJalaliLeapYear, jalaliMonthLength, toGregorian, toJalali } from './jalali';

describe( 'Gregorian <-> Jalali conversion', () => {
	it( 'matches the well-known golden reference point (Iranian Revolution Day)', () => {
		expect( toJalali( 1979, 2, 11 ) ).toEqual( { jy: 1357, jm: 11, jd: 22 } );
		expect( toGregorian( 1357, 11, 22 ) ).toEqual( { gy: 1979, gm: 2, gd: 11 } );
	} );

	it( 'places Nowruz 1403 on 2024-03-20', () => {
		expect( toJalali( 2024, 3, 20 ) ).toEqual( { jy: 1403, jm: 1, jd: 1 } );
		expect( toGregorian( 1403, 1, 1 ) ).toEqual( { gy: 2024, gm: 3, gd: 20 } );
	} );

	it( 'handles the year boundary correctly on both sides of Nowruz', () => {
		const dayBefore = toJalali( 2024, 3, 19 );
		expect( dayBefore.jy ).toBe( 1402 );
		expect( dayBefore.jm ).toBe( 12 );
	} );

	it( 'round-trips every day across a wide, multi-decade range with zero mismatches', () => {
		let failures = 0;
		for ( let y = 1970; y < 2035; y += 1 ) {
			for ( let m = 1; m <= 12; m += 1 ) {
				for ( let d = 1; d <= 28; d += 1 ) {
					const j = toJalali( y, m, d );
					const back = toGregorian( j.jy, j.jm, j.jd );
					if ( back.gy !== y || back.gm !== m || back.gd !== d ) {
						failures += 1;
					}
				}
			}
		}
		expect( failures ).toBe( 0 );
	} );

	it( 'round-trips Jalali dates including end-of-month for every month', () => {
		for ( let jy = 1400; jy <= 1410; jy += 1 ) {
			for ( let jm = 1; jm <= 12; jm += 1 ) {
				const lastDay = jalaliMonthLength( jy, jm );
				const g = toGregorian( jy, jm, lastDay );
				const back = toJalali( g.gy, g.gm, g.gd );
				expect( back ).toEqual( { jy, jm, jd: lastDay } );
			}
		}
	} );
} );

describe( 'Jalali leap years and month lengths', () => {
	it( 'gives every non-leap year exactly 365 days across its 12 months', () => {
		expect( isJalaliLeapYear( 1402 ) ).toBe( false );
		let total = 0;
		for ( let jm = 1; jm <= 12; jm += 1 ) {
			total += jalaliMonthLength( 1402, jm );
		}
		expect( total ).toBe( 365 );
	} );

	it( 'gives a leap year exactly 366 days, with a 30-day Esfand', () => {
		expect( isJalaliLeapYear( 1403 ) ).toBe( true );
		expect( jalaliMonthLength( 1403, 12 ) ).toBe( 30 );
		let total = 0;
		for ( let jm = 1; jm <= 12; jm += 1 ) {
			total += jalaliMonthLength( 1403, jm );
		}
		expect( total ).toBe( 366 );
	} );

	it( 'the first six months always have 31 days', () => {
		for ( let jm = 1; jm <= 6; jm += 1 ) {
			expect( jalaliMonthLength( 1404, jm ) ).toBe( 31 );
		}
	} );

	it( 'months 7 through 11 always have 30 days', () => {
		for ( let jm = 7; jm <= 11; jm += 1 ) {
			expect( jalaliMonthLength( 1404, jm ) ).toBe( 30 );
		}
	} );
} );
