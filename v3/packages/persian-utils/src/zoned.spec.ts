import {
	PERSIAN_WEEK_ORDER,
	PLATFORM_TIMEZONE,
	formatZonedFullDate,
	formatZonedTime,
	wallClockIn,
	zoneOffsetMinutes,
	zonedDateTimeToInstant,
	zonedIsoDate,
	zonedIsoTime,
} from './zoned';
import { formatTime } from './format';

/**
 * These helpers exist because the availability domain is defined in a NAMED
 * timezone, and the existing `format.ts` helpers read a `Date` in whatever
 * zone the host happens to be in. Every case below is therefore written to
 * fail if the implementation ever falls back to host-local time.
 */

describe( 'zoned wall-clock conversion', () => {
	it( 'reads an instant as the wall clock a person in Tehran would see', () => {
		// 2026-09-15T06:30:00Z. Iran is UTC+03:30 with no DST since 2022.
		const parts = wallClockIn( new Date( '2026-09-15T06:30:00.000Z' ) );
		expect( parts.hour ).toBe( 10 );
		expect( parts.minute ).toBe( 0 );
		expect( parts.year ).toBe( 2026 );
		expect( parts.month ).toBe( 9 );
		expect( parts.day ).toBe( 15 );
	} );

	it( 'reports the real zone offset from the IANA database, not a hardcoded constant', () => {
		expect( zoneOffsetMinutes( new Date( '2026-09-15T06:30:00.000Z' ) ) ).toBe( 210 );
		// Mid-winter too: a DST-observing implementation would differ here, and
		// Iran's abolition of DST is exactly the kind of policy that can be
		// reversed. Reading the zone rules keeps both answers correct.
		expect( zoneOffsetMinutes( new Date( '2026-01-15T06:30:00.000Z' ) ) ).toBe( 210 );
	} );

	it( 'round-trips a wall clock through an instant and back', () => {
		const instant = zonedDateTimeToInstant( '2026-09-15', '09:00' );
		expect( zonedIsoDate( instant ) ).toBe( '2026-09-15' );
		expect( zonedIsoTime( instant ) ).toBe( '09:00' );
	} );

	it( 'converts 09:00 Tehran to 05:30 UTC, not to 09:00 UTC', () => {
		const instant = zonedDateTimeToInstant( '2026-09-15', '09:00' );
		expect( instant.toISOString() ).toBe( '2026-09-15T05:30:00.000Z' );
	} );

	it( 'is independent of the host timezone', () => {
		// The regression this whole module exists to prevent.
		//
		// This case previously asserted the OPPOSITE relationship: that
		// `formatTime` must DISAGREE with `formatZonedTime` on any host outside
		// Tehran, because `formatTime` read host-local time "by design". That
		// made the defect a requirement, and it is why the assertion had to be
		// rewritten rather than merely re-run when Phase G closed `R31-09` --
		// `formatTime` now delegates here, so the two agree everywhere.
		//
		// The replacement is strictly stronger: it pins the absolute answer,
		// asserts the delegation holds on EVERY host rather than conditionally,
		// and keeps a case that would still fail if either function started
		// reading the ambient clock again.
		const instant = new Date( '2026-09-15T06:30:00.000Z' );
		const zoned = formatZonedTime( instant );

		expect( zoned ).toBe( '۱۰:۰۰' );
		expect( formatTime( instant ) ).toBe( zoned );
		// Not trivially true: a genuinely different zone still reads differently.
		expect( formatZonedTime( instant, 'UTC' ) ).toBe( '۰۶:۳۰' );
	} );

	it( 'assigns a late-evening Tehran instant to the correct Tehran DAY', () => {
		// 21:30 UTC on the 14th is 01:00 on the 15th in Tehran. A host in UTC
		// reading `getDate()` would file this under the 14th.
		const instant = new Date( '2026-09-14T21:30:00.000Z' );
		expect( zonedIsoDate( instant ) ).toBe( '2026-09-15' );
		expect( zonedIsoTime( instant ) ).toBe( '01:00' );
	} );

	it( 'derives the weekday from the ZONE, not from the host', () => {
		// 2026-09-14T21:30Z is Tuesday 15 September in Tehran (weekday 2).
		expect( wallClockIn( new Date( '2026-09-14T21:30:00.000Z' ) ).weekday ).toBe( 2 );
	} );
} );

describe( 'Jalali rendering in the platform zone', () => {
	it( 'renders a full Jalali date with Persian digits', () => {
		const rendered = formatZonedFullDate( new Date( '2026-09-15T06:30:00.000Z' ) );
		// Real calendar conversion, not digit substitution: 2026-09-15 Gregorian
		// is 24 شهریور 1405.
		expect( rendered ).toContain( 'شهریور' );
		expect( rendered ).toContain( '۱۴۰۵' );
		expect( rendered ).not.toMatch( /[0-9]/ );
	} );

	it( 'renders times in Persian digits', () => {
		expect( formatZonedTime( new Date( '2026-09-15T06:30:00.000Z' ) ) ).toBe( '۱۰:۰۰' );
	} );

	it( 'emits ASCII for machine-facing values, because an input value is not display text', () => {
		// `zonedIsoTime`/`zonedIsoDate` feed <input type="time"|"date"> and API
		// parameters. Persian digits there would be rejected by both.
		expect( zonedIsoTime( new Date( '2026-09-15T06:30:00.000Z' ) ) ).toBe( '10:00' );
		expect( zonedIsoDate( new Date( '2026-09-15T06:30:00.000Z' ) ) ).toBe( '2026-09-15' );
	} );
} );

describe( 'weekday ordering', () => {
	it( 'displays Saturday first while preserving the backend 0=Sunday indices', () => {
		expect( PERSIAN_WEEK_ORDER[ 0 ] ).toEqual( { index: 6, label: 'شنبه' } );
		expect( PERSIAN_WEEK_ORDER.map( ( d ) => d.index ).sort() ).toEqual( [ 0, 1, 2, 3, 4, 5, 6 ] );
		// The trap this guards: reordering for a Persian week must NOT renumber
		// the days, because those numbers are what `bulkGenerate` matches on.
		expect( PERSIAN_WEEK_ORDER.find( ( d ) => d.label === 'یکشنبه' )?.index ).toBe( 0 );
	} );
} );

describe( 'platform timezone constant', () => {
	it( 'matches booking-service’s own PLATFORM_TIMEZONE', () => {
		// Duplicated across a module boundary by necessity (a frontend package
		// may not import a service), so it is asserted rather than assumed.
		expect( PLATFORM_TIMEZONE ).toBe( 'Asia/Tehran' );
	} );
} );
