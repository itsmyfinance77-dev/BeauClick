/**
 * Timezone-explicit Jalali/Persian date formatting.
 *
 * This is the ONE implementation of "what wall clock does this instant read as
 * in the platform's timezone". `format.ts`'s `formatShortDate` /
 * `formatFullJalaliDate` / `formatTime` are thin delegates to the three
 * formatters below.
 *
 * That was not always so, and the history is the reason this module names its
 * zone so insistently. Those three helpers originally resolved a `Date`
 * through `getFullYear()` / `getHours()`, which read whatever timezone the
 * browser or server process happened to be running in. Task 1 added this
 * module for the professional availability surface, where the defect was
 * obvious -- a professional publishing "09:00" means 09:00 in Tehran, and
 * booking-service materializes the slot from exactly that wall clock
 * (`services/booking/src/availability/platform-time.ts`) -- and deliberately
 * left the customer surfaces alone, recording the inconsistency as `R31-09`.
 *
 * Phase G closed it, having found the bug was live rather than latent: the API
 * builds the `date` and `time` variables of its booking notifications with
 * those same helpers, server-side, in a process where nothing sets `TZ`. Every
 * customer on a UTC-hosted deployment was told an appointment time three and a
 * half hours early.
 *
 * The conversion mechanics deliberately mirror the backend's own
 * `platform-time.ts` (IANA rules via `Intl`, two-pass offset resolution)
 * rather than a hardcoded +03:30. Iran abolished DST in 2022, so a fixed
 * offset is right today and would produce silently one-hour-wrong times for
 * every affected day if that is ever reversed.
 */
import { JALALI_MONTHS, toJalali } from './jalali';
import { toPersianDigits } from './digits';

/** The platform's operating timezone. Must match booking-service's `PLATFORM_TIMEZONE`. */
export const PLATFORM_TIMEZONE = 'Asia/Tehran';

const PERSIAN_WEEKDAYS = [ 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه' ];

export interface ZonedWallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 0 = Sunday .. 6 = Saturday, as seen in the zone. */
	weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter( timeZone: string ): Intl.DateTimeFormat {
	let cached = formatterCache.get( timeZone );
	if ( ! cached ) {
		cached = new Intl.DateTimeFormat( 'en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		} );
		formatterCache.set( timeZone, cached );
	}
	return cached;
}

/** The wall-clock reading a person in `timeZone` sees at this instant. */
export function wallClockIn( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): ZonedWallClock {
	const parts = formatter( timeZone ).formatToParts( instant );
	const read = ( type: Intl.DateTimeFormatPartTypes ): number =>
		Number( parts.find( ( p ) => p.type === type )?.value ?? '0' );
	const year = read( 'year' );
	const month = read( 'month' );
	const day = read( 'day' );
	return {
		year,
		month,
		day,
		hour: read( 'hour' ),
		minute: read( 'minute' ),
		second: read( 'second' ),
		// Built from the ZONE's own y/m/d, never `instant.getDay()`, which
		// would read the host timezone and mislabel a 00:30 Tehran Saturday
		// as Friday on a UTC machine.
		weekday: new Date( Date.UTC( year, month - 1, day ) ).getUTCDay(),
	};
}

/** The zone's UTC offset in minutes at a given instant. Positive east of Greenwich. */
export function zoneOffsetMinutes( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): number {
	const p = wallClockIn( instant, timeZone );
	const asIfUtc = Date.UTC( p.year, p.month - 1, p.day, p.hour, p.minute, p.second );
	return Math.round( ( asIfUtc - instant.getTime() ) / 60_000 );
}

/**
 * `YYYY-MM-DD` + `HH:mm`, both read as wall clock IN `timeZone`, to a real instant.
 *
 * Two passes, not one, for the same reason the backend's own converter uses
 * two: the offset can only be looked up FOR an instant, and the instant is
 * what we are solving for. Pass one guesses with the offset at the naive-UTC
 * reading; pass two re-reads the offset at that candidate and corrects.
 */
export function zonedDateTimeToInstant(
	isoDate: string,
	isoTime: string,
	timeZone: string = PLATFORM_TIMEZONE,
): Date {
	const [ y, m, d ] = isoDate.split( '-' ).map( Number );
	const [ hh, mm ] = isoTime.split( ':' ).map( Number );
	const naiveUtc = Date.UTC( y, m - 1, d, hh, mm, 0 );
	let candidate = new Date( naiveUtc - zoneOffsetMinutes( new Date( naiveUtc ), timeZone ) * 60_000 );
	candidate = new Date( naiveUtc - zoneOffsetMinutes( candidate, timeZone ) * 60_000 );
	return candidate;
}

/** `YYYY-MM-DD` as seen in the zone — the format every backend date parameter expects. */
export function zonedIsoDate( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): string {
	const p = wallClockIn( instant, timeZone );
	return `${ String( p.year ).padStart( 4, '0' ) }-${ String( p.month ).padStart( 2, '0' ) }-${ String( p.day ).padStart( 2, '0' ) }`;
}

/** `HH:mm` as seen in the zone, ASCII digits — for `<input type="time">` values. */
export function zonedIsoTime( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): string {
	const p = wallClockIn( instant, timeZone );
	return `${ String( p.hour ).padStart( 2, '0' ) }:${ String( p.minute ).padStart( 2, '0' ) }`;
}

/** `HH:mm` in Persian digits, as seen in the zone — for display. */
export function formatZonedTime( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): string {
	return toPersianDigits( zonedIsoTime( instant, timeZone ) );
}

/** Weekday + Jalali day + Jalali month, as seen in the zone. */
export function formatZonedShortDate(
	instant: Date,
	timeZone: string = PLATFORM_TIMEZONE,
): { weekday: string; day: string; month: string } {
	const p = wallClockIn( instant, timeZone );
	const { jm, jd } = toJalali( p.year, p.month, p.day );
	return {
		weekday: PERSIAN_WEEKDAYS[ p.weekday ],
		day: toPersianDigits( jd ),
		month: JALALI_MONTHS[ jm - 1 ],
	};
}

/** Complete "چهارشنبه، ۲۲ مرداد ۱۴۰۵", as seen in the zone. */
export function formatZonedFullDate( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): string {
	const p = wallClockIn( instant, timeZone );
	const { jy, jm, jd } = toJalali( p.year, p.month, p.day );
	return `${ PERSIAN_WEEKDAYS[ p.weekday ] }، ${ toPersianDigits( jd ) } ${ JALALI_MONTHS[ jm - 1 ] } ${ toPersianDigits( jy ) }`;
}

/** "چهارشنبه، ۲۲ مرداد ۱۴۰۵ — ساعت ۰۹:۳۰" — the one-line form slot and booking rows use. */
export function formatZonedDateTime( instant: Date, timeZone: string = PLATFORM_TIMEZONE ): string {
	return `${ formatZonedFullDate( instant, timeZone ) } — ساعت ${ formatZonedTime( instant, timeZone ) }`;
}

/**
 * The Jalali label for a weekday index, using the SAME 0=Sunday convention
 * booking-service's `bulkGenerate` expects for its `weekdays` array. Stated
 * explicitly because 0=Sunday is not the Persian week's own ordering (which
 * starts Saturday), and a UI that reordered the checkboxes for display must
 * still submit these indices.
 */
export const PERSIAN_WEEKDAY_LABELS: readonly string[] = PERSIAN_WEEKDAYS;

/** Saturday-first display order, carrying each day's backend index with it. */
export const PERSIAN_WEEK_ORDER: readonly { index: number; label: string }[] = [
	{ index: 6, label: 'شنبه' },
	{ index: 0, label: 'یکشنبه' },
	{ index: 1, label: 'دوشنبه' },
	{ index: 2, label: 'سه‌شنبه' },
	{ index: 3, label: 'چهارشنبه' },
	{ index: 4, label: 'پنجشنبه' },
	{ index: 5, label: 'جمعه' },
];
