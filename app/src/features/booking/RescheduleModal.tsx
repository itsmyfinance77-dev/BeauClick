import { useEffect, useState } from 'react';
import { Modal, Button, Chip, LoadingDots } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import { formatShortDate, formatFullJalaliDate, formatTime } from '@/lib/format';
import type { AvailabilitySlot } from './types';

export interface RescheduleTarget {
	id: number;
	providerId: number;
	slotStart: string;
}

interface Eligibility {
	eligible: boolean;
	reason: string | null;
	rescheduleCount: number;
	maxReschedules: number;
	minHoursBefore: number;
}

const NEXT_14_DAYS = Array.from( { length: 14 }, ( _, i ) => {
	const d = new Date();
	d.setDate( d.getDate() + i );
	return d;
} );

/** Same local-date derivation BookingModal.tsx already uses -- avoids the
 * UTC-midnight-in-Iran off-by-one bug of `toISOString().slice(0,10)`. */
function localDateString( d: Date ): string {
	const y = d.getFullYear();
	const m = String( d.getMonth() + 1 ).padStart( 2, '0' );
	const day = String( d.getDate() ).padStart( 2, '0' );
	return `${ y }-${ m }-${ day }`;
}

const INELIGIBLE_REASON_LABELS: Record<string, string> = {
	status: 'این رزرو در وضعیتی نیست که بتوان آن را جابه‌جا کرد.',
	max_reached: 'این رزرو به حداکثر تعداد مجاز جابه‌جایی رسیده است.',
	too_close: 'برای جابه‌جایی این نوبت، زمان کافی تا شروع آن باقی نمانده است.',
};

/**
 * Reuses BookingModal's own date-chip/time-chip picker shape (§20's own
 * "use existing Booking components where appropriate" instruction) rather
 * than building a second slot-selection widget. Scoped to same
 * provider/service by construction -- RescheduleService itself is the real
 * enforcement, this UI just never offers a slot outside that scope.
 */
export function RescheduleModal( { open, onClose, booking, onRescheduled }: {
	open: boolean;
	onClose: () => void;
	booking: RescheduleTarget | null;
	onRescheduled: () => void;
} ) {
	const [ eligibility, setEligibility ] = useState<Eligibility | null>( null );
	const [ selectedDateIdx, setSelectedDateIdx ] = useState( 0 );
	const [ slots, setSlots ] = useState<AvailabilitySlot[]>( [] );
	const [ selectedSlot, setSelectedSlot ] = useState<AvailabilitySlot | null>( null );
	const [ loading, setLoading ] = useState( false );
	const [ submitting, setSubmitting ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		if ( ! open || ! booking ) return;
		setEligibility( null );
		setSelectedSlot( null );
		setSelectedDateIdx( 0 );
		setError( null );
		api.get<Eligibility>( `/booking/bookings/${ booking.id }/reschedule-eligibility` )
			.then( setEligibility )
			.catch( () => setError( 'خطا در بررسی امکان جابه‌جایی.' ) );
	}, [ open, booking ] );

	useEffect( () => {
		if ( ! open || ! booking || ! eligibility?.eligible ) return;
		const date = localDateString( NEXT_14_DAYS[ selectedDateIdx ] );
		setLoading( true );
		setSelectedSlot( null );
		api.get<AvailabilitySlot[]>( `/booking/availability?provider_id=${ booking.providerId }&date=${ date }` )
			.then( setSlots )
			.catch( () => setError( 'خطا در دریافت زمان‌های آزاد.' ) )
			.finally( () => setLoading( false ) );
	}, [ open, booking, eligibility, selectedDateIdx ] );

	async function confirmReschedule() {
		if ( ! booking || ! selectedSlot ) return;
		setSubmitting( true );
		setError( null );
		try {
			await api.post( `/booking/bookings/${ booking.id }/reschedule`, { new_slot_id: selectedSlot.id } );
			onRescheduled();
			onClose();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'جابه‌جایی نوبت با خطا مواجه شد.' );
		} finally {
			setSubmitting( false );
		}
	}

	if ( ! booking ) return null;

	return (
		<Modal open={ open } onClose={ onClose } labelledBy="bc-reschedule-title">
			<div style={ { padding: 24, minWidth: 320 } }>
				<h3 id="bc-reschedule-title" style={ { marginTop: 0 } }>جابه‌جایی نوبت</h3>

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }

				{ ! eligibility && ! error && <LoadingDots /> }

				{ eligibility && ! eligibility.eligible && (
					<p style={ { color: 'var(--bc-color-ink-faint)' } }>
						{ INELIGIBLE_REASON_LABELS[ eligibility.reason ?? '' ] ?? 'این رزرو در حال حاضر قابل جابه‌جایی نیست.' }
					</p>
				) }

				{ eligibility?.eligible && (
					<>
						<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', marginTop: 0 } }>
							تعداد جابه‌جایی‌های استفاده‌شده: { eligibility.rescheduleCount } از { eligibility.maxReschedules }
						</p>

						<div style={ { display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 12 } }>
							{ NEXT_14_DAYS.map( ( d, i ) => {
								const { weekday, day, month } = formatShortDate( d );
								return (
									<Chip key={ i } active={ selectedDateIdx === i } onClick={ () => setSelectedDateIdx( i ) }>
										<span style={ { display: 'flex', flexDirection: 'column', alignItems: 'center' } }>
											<span>{ weekday }</span>
											<span className="bc-numeric">{ day } { month }</span>
										</span>
									</Chip>
								);
							} ) }
						</div>

						{ loading && <LoadingDots /> }
						{ ! loading && slots.length === 0 && (
							<p style={ { color: 'var(--bc-color-ink-faint)' } }>زمان آزادی در این روز وجود ندارد.</p>
						) }
						<div style={ { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 } }>
							{ slots.map( ( slot ) => (
								<Chip key={ slot.id } active={ selectedSlot?.id === slot.id } onClick={ () => setSelectedSlot( slot ) }>
									{ formatTime( new Date( slot.startAt.replace( ' ', 'T' ) ) ) }
								</Chip>
							) ) }
						</div>

						{ selectedSlot && (
							<p style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>
								از { formatFullJalaliDate( new Date( booking.slotStart.replace( ' ', 'T' ) ) ) } به { formatFullJalaliDate( new Date( selectedSlot.startAt.replace( ' ', 'T' ) ) ) }، { formatTime( new Date( selectedSlot.startAt.replace( ' ', 'T' ) ) ) }
							</p>
						) }

						<div style={ { display: 'flex', justifyContent: 'space-between', marginTop: 16 } }>
							<Button variant="ghost" onClick={ onClose }>انصراف</Button>
							<Button variant="primary" disabled={ ! selectedSlot || submitting } onClick={ confirmReschedule }>
								{ submitting ? 'در حال ثبت…' : 'تأیید جابه‌جایی' }
							</Button>
						</div>
					</>
				) }
			</div>
		</Modal>
	);
}
