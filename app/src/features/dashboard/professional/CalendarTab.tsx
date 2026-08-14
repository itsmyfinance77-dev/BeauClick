import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate, formatTime, toPersianDigits } from '@/lib/format';
import { Button, Chip, Input, LoadingDots, EmptyState, Badge } from '@/design-system';

interface Slot {
	id: number;
	serviceId: number | null;
	startAt: string;
	endAt: string;
	status: string;
}

const STATUS_LABELS: Record<string, string> = { open: 'آزاد', held: 'در انتظار پرداخت', booked: 'رزرو‌شده' };

const WEEKDAYS = [
	{ id: 6, label: 'شنبه' },
	{ id: 0, label: 'یکشنبه' },
	{ id: 1, label: 'دوشنبه' },
	{ id: 2, label: 'سه‌شنبه' },
	{ id: 3, label: 'چهارشنبه' },
	{ id: 4, label: 'پنج‌شنبه' },
	{ id: 5, label: 'جمعه' },
];

function localDateString( d: Date ): string {
	const y = d.getFullYear();
	const m = String( d.getMonth() + 1 ).padStart( 2, '0' );
	const day = String( d.getDate() ).padStart( 2, '0' );
	return `${ y }-${ m }-${ day }`;
}

function groupByDay( slots: Slot[] ): [ string, Slot[] ][] {
	const groups = new Map<string, Slot[]>();
	for ( const slot of slots ) {
		const day = slot.startAt.slice( 0, 10 );
		if ( ! groups.has( day ) ) groups.set( day, [] );
		groups.get( day )!.push( slot );
	}
	return Array.from( groups.entries() );
}

/**
 * V2.2 Step 16 — before this tab, no real code path let a professional
 * create a bookable slot at all (`wp_bc_availability_slots` had exactly one
 * writer in the whole codebase: a dev-only demo seed script). This is
 * deliberately NOT a calendar-grid/drag-and-drop widget — a single-slot
 * form plus a "generate from a weekly pattern" bulk form, matching the
 * task's own "do not build a full Google Calendar replacement... only if
 * genuinely necessary" instruction while actually closing the gap.
 */
export function CalendarTab() {
	const [ slots, setSlots ] = useState<Slot[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ busyId, setBusyId ] = useState<number | null>( null );

	function load() {
		api.get<Slot[]>( '/booking/my/availability' ).then( setSlots ).catch( () => setError( 'خطا در دریافت زمان‌های شما.' ) );
	}
	useEffect( load, [] );

	async function removeSlot( id: number ) {
		setBusyId( id );
		try {
			await api.del( `/booking/my/availability/${ id }` );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'حذف این زمان ممکن نیست.' );
		} finally {
			setBusyId( null );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;

	const groups = slots ? groupByDay( slots ) : [];

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>تقویم و زمان‌های آزاد</h1>

			<AddSlotForm onCreated={ load } />
			<BulkGenerateForm onGenerated={ load } />

			<div className="bc-card" style={ { padding: 16, marginTop: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>زمان‌های آینده شما</h3>
				{ ! slots && <LoadingDots /> }
				{ slots && groups.length === 0 && <EmptyState title="هنوز زمانی ثبت نکرده‌اید." /> }
				{ groups.map( ( [ day, daySlots ] ) => (
					<div key={ day } style={ { marginBottom: 14 } }>
						<p className="bc-numeric" style={ { fontSize: 13, fontWeight: 700, margin: '0 0 6px' } }>
							{ formatFullJalaliDate( new Date( `${ day }T00:00:00` ) ) }
						</p>
						<div style={ { display: 'flex', flexWrap: 'wrap', gap: 8 } }>
							{ daySlots.map( ( s ) => (
								<div key={ s.id } style={ { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 10, border: '1px solid var(--bc-color-line)' } }>
									<span className="bc-numeric" style={ { fontSize: 13 } }>{ formatTime( new Date( s.startAt.replace( ' ', 'T' ) ) ) }</span>
									<Badge variant={ s.status === 'open' ? 'success' : s.status === 'booked' ? 'discount' : 'warning' }>{ STATUS_LABELS[ s.status ] ?? s.status }</Badge>
									{ 'open' === s.status && (
										<button
											type="button"
											aria-label="حذف این زمان"
											disabled={ busyId === s.id }
											onClick={ () => removeSlot( s.id ) }
											style={ { border: 'none', background: 'none', color: 'var(--bc-color-error)', cursor: 'pointer', fontSize: 13 } }
										>
											حذف
										</button>
									) }
								</div>
							) ) }
						</div>
					</div>
				) ) }
			</div>
		</div>
	);
}

function AddSlotForm( { onCreated }: { onCreated: () => void } ) {
	const [ date, setDate ] = useState( localDateString( new Date() ) );
	const [ time, setTime ] = useState( '10:00' );
	const [ durationMinutes, setDurationMinutes ] = useState( 60 );
	const [ submitting, setSubmitting ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	async function submit() {
		setSubmitting( true );
		setError( null );
		try {
			const startAt = `${ date } ${ time }:00`;
			const startMs = new Date( `${ date }T${ time }:00` ).getTime();
			const endAt = new Date( startMs + durationMinutes * 60000 );
			const endAtStr = `${ localDateString( endAt ) } ${ String( endAt.getHours() ).padStart( 2, '0' ) }:${ String( endAt.getMinutes() ).padStart( 2, '0' ) }:00`;
			await api.post( '/booking/my/availability', { start_at: startAt, end_at: endAtStr } );
			onCreated();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ثبت زمان با خطا مواجه شد.' );
		} finally {
			setSubmitting( false );
		}
	}

	return (
		<div className="bc-card" style={ { padding: 16, marginBottom: 16 } }>
			<h3 style={ { marginTop: 0, fontSize: 15 } }>افزودن یک زمان آزاد</h3>
			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
			<div style={ { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } }>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					تاریخ
					<Input type="date" value={ date } onChange={ ( e ) => setDate( e.target.value ) } aria-label="تاریخ" />
				</label>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					ساعت شروع
					<Input type="time" value={ time } onChange={ ( e ) => setTime( e.target.value ) } aria-label="ساعت شروع" />
				</label>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					مدت (دقیقه)
					<Input type="number" min={ 10 } max={ 480 } value={ durationMinutes } onChange={ ( e ) => setDurationMinutes( Number( e.target.value ) ) } aria-label="مدت به دقیقه" style={ { width: 90 } } />
				</label>
				<Button variant="primary" disabled={ submitting } onClick={ submit }>{ submitting ? 'در حال ثبت…' : 'افزودن' }</Button>
			</div>
		</div>
	);
}

function BulkGenerateForm( { onGenerated }: { onGenerated: () => void } ) {
	const [ weekdays, setWeekdays ] = useState<number[]>( [ 6, 0, 1, 2, 3 ] );
	const [ timeStart, setTimeStart ] = useState( '10:00' );
	const [ timeEnd, setTimeEnd ] = useState( '18:00' );
	const [ slotMinutes, setSlotMinutes ] = useState( 60 );
	const [ dateFrom, setDateFrom ] = useState( localDateString( new Date() ) );
	const [ dateTo, setDateTo ] = useState( localDateString( new Date( Date.now() + 13 * 86400000 ) ) );
	const [ submitting, setSubmitting ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );
	const [ result, setResult ] = useState<{ created: number; skipped: number } | null>( null );

	function toggleDay( day: number ) {
		setWeekdays( ( prev ) => ( prev.includes( day ) ? prev.filter( ( d ) => d !== day ) : [ ...prev, day ] ) );
	}

	async function submit() {
		setSubmitting( true );
		setError( null );
		setResult( null );
		try {
			const res = await api.post<{ created: number; skipped: number }>( '/booking/my/availability/bulk', {
				weekdays,
				time_start: timeStart,
				time_end: timeEnd,
				slot_minutes: slotMinutes,
				date_from: dateFrom,
				date_to: dateTo,
			} );
			setResult( res );
			onGenerated();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ایجاد زمان‌ها با خطا مواجه شد.' );
		} finally {
			setSubmitting( false );
		}
	}

	return (
		<div className="bc-card" style={ { padding: 16 } }>
			<h3 style={ { marginTop: 0, fontSize: 15 } }>ایجاد زمان‌های تکراری هفتگی</h3>
			<p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', marginTop: 0 } }>
				روزهای هفته، بازه ساعتی و مدت هر نوبت را انتخاب کنید تا زمان‌های آزاد برای بازه تاریخ مشخص‌شده ساخته شود.
			</p>
			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
			{ result && (
				<p role="status" style={ { color: 'var(--bc-color-success)', fontSize: 13 } } className="bc-numeric">
					{ toPersianDigits( result.created ) } زمان ایجاد شد{ result.skipped > 0 ? ` (${ toPersianDigits( result.skipped ) } زمان تکراری نادیده گرفته شد)` : '' }.
				</p>
			) }

			<div style={ { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } }>
				{ WEEKDAYS.map( ( w ) => (
					<Chip key={ w.id } active={ weekdays.includes( w.id ) } onClick={ () => toggleDay( w.id ) }>{ w.label }</Chip>
				) ) }
			</div>

			<div style={ { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 } }>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					از ساعت
					<Input type="time" value={ timeStart } onChange={ ( e ) => setTimeStart( e.target.value ) } aria-label="از ساعت" />
				</label>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					تا ساعت
					<Input type="time" value={ timeEnd } onChange={ ( e ) => setTimeEnd( e.target.value ) } aria-label="تا ساعت" />
				</label>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					مدت هر نوبت (دقیقه)
					<Input type="number" min={ 10 } max={ 480 } value={ slotMinutes } onChange={ ( e ) => setSlotMinutes( Number( e.target.value ) ) } aria-label="مدت هر نوبت" style={ { width: 90 } } />
				</label>
			</div>

			<div style={ { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } }>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					از تاریخ
					<Input type="date" value={ dateFrom } onChange={ ( e ) => setDateFrom( e.target.value ) } aria-label="از تاریخ" />
				</label>
				<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } }>
					تا تاریخ
					<Input type="date" value={ dateTo } onChange={ ( e ) => setDateTo( e.target.value ) } aria-label="تا تاریخ" />
				</label>
				<Button variant="primary" disabled={ submitting || weekdays.length === 0 } onClick={ submit }>
					{ submitting ? 'در حال ایجاد…' : 'ایجاد زمان‌ها' }
				</Button>
			</div>
		</div>
	);
}
