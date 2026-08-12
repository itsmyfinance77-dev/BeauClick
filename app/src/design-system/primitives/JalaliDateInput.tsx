import type { CSSProperties } from 'react';
import { toGregorian, toJalali, jalaliMonthLength, JALALI_MONTHS } from '@/lib/jalali';
import { toPersianDigits } from '@/lib/format';

export interface JalaliDateInputProps {
	/** Gregorian YYYY-MM-DD -- the same internal/API representation every
	 * other date on this endpoint already uses (see JalaliDate's own
	 * conversion-boundary docblock: storage/domain logic stays Gregorian,
	 * only input/display is Jalali). Empty string/undefined = no date set. */
	value?: string | null;
	onChange: ( gregorianYmd: string ) => void;
	ariaLabel: string;
	/** How many Jalali years forward from the current year to offer -- a
	 * goal target date is near-term by nature, so a wide birthdate-style
	 * range isn't the right default; callers picking a past-date field
	 * (none exist in this app yet) would need a different range. */
	yearsAhead?: number;
}

/**
 * Three native <select>s (day/month/year), not a calendar-grid widget --
 * the smallest input that actually satisfies "Jalali input, Gregorian
 * storage" without a new dependency or a full custom calendar component,
 * matching the task's own "do not overdo" instruction for this scope. Any
 * future feature needing a Jalali date input should reuse this rather than
 * another native `<input type="date">` (which only ever renders Gregorian
 * in every mainstream browser).
 */
export function JalaliDateInput( { value, onChange, ariaLabel, yearsAhead = 5 }: JalaliDateInputProps ) {
	const today = new Date();
	const todayJalali = toJalali( today.getFullYear(), today.getMonth() + 1, today.getDate() );

	let selected: { jy: number; jm: number; jd: number } | null = null;
	if ( value ) {
		const [ gy, gm, gd ] = value.split( '-' ).map( Number );
		if ( ! [ gy, gm, gd ].some( Number.isNaN ) ) {
			selected = toJalali( gy, gm, gd );
		}
	}

	const jy = selected?.jy ?? todayJalali.jy;
	const jm = selected?.jm ?? todayJalali.jm;
	const jd = selected?.jd ?? todayJalali.jd;

	function emit( nextJy: number, nextJm: number, nextJd: number ) {
		const maxDay = jalaliMonthLength( nextJy, nextJm );
		const clampedJd = Math.min( nextJd, maxDay );
		const { gy, gm, gd } = toGregorian( nextJy, nextJm, clampedJd );
		onChange( `${ gy.toString().padStart( 4, '0' ) }-${ gm.toString().padStart( 2, '0' ) }-${ gd.toString().padStart( 2, '0' ) }` );
	}

	const selectStyle: CSSProperties = {
		padding: '10px 8px',
		borderRadius: 10,
		border: '1px solid var(--bc-color-line)',
		fontSize: 14,
		background: 'var(--bc-color-surface)',
		color: 'inherit',
	};

	const dayCount = jalaliMonthLength( jy, jm );

	return (
		<div role="group" aria-label={ ariaLabel } style={ { display: 'flex', gap: 6 } }>
			<select aria-label={ `${ ariaLabel } - روز` } value={ selected ? jd : '' } onChange={ ( e ) => emit( jy, jm, Number( e.target.value ) ) } style={ { ...selectStyle, flex: 1 } }>
				<option value="" disabled>روز</option>
				{ Array.from( { length: dayCount }, ( _, i ) => i + 1 ).map( ( d ) => (
					<option key={ d } value={ d } className="bc-numeric">{ toPersianDigits( d ) }</option>
				) ) }
			</select>
			<select aria-label={ `${ ariaLabel } - ماه` } value={ selected ? jm : '' } onChange={ ( e ) => emit( jy, Number( e.target.value ), jd ) } style={ { ...selectStyle, flex: 1.4 } }>
				<option value="" disabled>ماه</option>
				{ JALALI_MONTHS.map( ( name, i ) => (
					<option key={ name } value={ i + 1 }>{ name }</option>
				) ) }
			</select>
			<select aria-label={ `${ ariaLabel } - سال` } value={ selected ? jy : '' } onChange={ ( e ) => emit( Number( e.target.value ), jm, jd ) } style={ { ...selectStyle, flex: 1 } }>
				<option value="" disabled>سال</option>
				{ Array.from( { length: yearsAhead + 1 }, ( _, i ) => todayJalali.jy + i ).map( ( y ) => (
					<option key={ y } value={ y } className="bc-numeric">{ toPersianDigits( y ) }</option>
				) ) }
			</select>
		</div>
	);
}
