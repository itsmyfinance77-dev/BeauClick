import { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Chip, PriceTag, LoadingDots } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import { formatShortDate, formatTime } from '@/lib/format';
import type { AvailabilitySlot, ProviderDetail, ProviderService } from './types';

export interface BookingModalProps {
	open: boolean;
	onClose: () => void;
	providerId: number;
	/** Pre-select a service when opened from a service row's own "رزرو" CTA. */
	initialServiceId?: number;
}

type Step = 1 | 2 | 3 | 4 | 5;

const NEXT_7_DAYS = Array.from( { length: 7 }, ( _, i ) => {
	const d = new Date();
	d.setDate( d.getDate() + i );
	return d;
} );

/**
 * Service -> date -> time -> review & confirm -> success, per the design
 * handoff's 5-step booking flow. Step 4 is "review & confirm" rather than
 * "review & pay" for now — WooCommerce payment wiring lands in Phase 6
 * (beauclick-payments); until then, confirming creates a `pending` booking
 * directly. Nothing about this component's shape changes when payment
 * lands — step 4's action swaps from a direct API call to a checkout
 * redirect, the rest of the flow is unaffected.
 */
export function BookingModal( { open, onClose, providerId, initialServiceId }: BookingModalProps ) {
	const [ step, setStep ] = useState<Step>( 1 );
	const [ provider, setProvider ] = useState<ProviderDetail | null>( null );
	const [ selectedService, setSelectedService ] = useState<ProviderService | null>( null );
	const [ selectedDateIdx, setSelectedDateIdx ] = useState( 0 );
	const [ slots, setSlots ] = useState<AvailabilitySlot[]>( [] );
	const [ selectedSlot, setSelectedSlot ] = useState<AvailabilitySlot | null>( null );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		if ( ! open ) return;
		setStep( 1 );
		setSelectedSlot( null );
		setError( null );
		api.get<ProviderDetail>( `/marketplace/providers/${ providerId }` )
			.then( ( p ) => {
				setProvider( p );
				const preset = initialServiceId ? p.services.find( ( s ) => s.id === initialServiceId ) : null;
				if ( preset ) {
					setSelectedService( preset );
					setStep( 2 );
				}
			} )
			.catch( () => setError( 'خطا در دریافت اطلاعات متخصص.' ) );
	}, [ open, providerId, initialServiceId ] );

	useEffect( () => {
		if ( step !== 3 ) return;
		const date = NEXT_7_DAYS[ selectedDateIdx ].toISOString().slice( 0, 10 );
		setLoading( true );
		api.get<AvailabilitySlot[]>( `/booking/availability?provider_id=${ providerId }&date=${ date }` )
			.then( setSlots )
			.catch( () => setError( 'خطا در دریافت زمان‌های آزاد.' ) )
			.finally( () => setLoading( false ) );
	}, [ step, selectedDateIdx, providerId ] );

	const canGoNext = useMemo( () => {
		if ( step === 1 ) return !! selectedService;
		if ( step === 3 ) return !! selectedSlot;
		return true;
	}, [ step, selectedService, selectedSlot ] );

	async function handleConfirm() {
		if ( ! selectedSlot ) return;
		setLoading( true );
		setError( null );
		try {
			const result = await api.post<{ bookingId: number; payUrl?: string }>( '/booking/bookings', {
				provider_id: providerId,
				slot_id: selectedSlot.id,
				service_id: selectedService?.id,
			} );

			if ( result.payUrl ) {
				// A real WooCommerce order was created (beauclick-payments
				// active) — the actual payment happens on WooCommerce's own
				// pay-for-order page (real gateways are redirect-based; there
				// is no same-page "success" to show until that round trip
				// completes and the order is paid). Step 5 here would be
				// misleading — the booking is still just 'pending'.
				window.location.href = result.payUrl;
				return;
			}

			// No payments module active (e.g. local testing without
			// WooCommerce wired up) — the booking still exists as 'pending',
			// shown here as a reasonable terminal state for that case.
			setStep( 5 );
		} catch ( e ) {
			setError( e instanceof ApiError && e.status === 409 ? e.message : 'رزرو با خطا مواجه شد. لطفاً دوباره تلاش کنید.' );
		} finally {
			setLoading( false );
		}
	}

	return (
		<Modal open={ open } onClose={ onClose } labelledBy="bc-booking-title">
			<div style={ { padding: 24, minWidth: 320 } }>
				{ step < 5 && (
					<div style={ { display: 'flex', gap: 6, marginBottom: 20 } } aria-hidden="true">
						{ [ 1, 2, 3, 4 ].map( ( n ) => (
							<span
								key={ n }
								style={ {
									height: 6,
									borderRadius: 999,
									width: n === step ? 24 : 8,
									background: n <= step ? 'var(--bc-color-primary)' : 'var(--bc-color-line)',
									transition: 'width 160ms ease',
								} }
							/>
						) ) }
					</div>
				) }

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }

				{ step === 1 && (
					<section>
						<h3 id="bc-booking-title" style={ { marginTop: 0 } }>۱. انتخاب خدمت</h3>
						{ ! provider && <LoadingDots /> }
						<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
							{ provider?.services.map( ( s ) => (
								<button
									key={ s.id }
									type="button"
									onClick={ () => setSelectedService( s ) }
									style={ {
										textAlign: 'start',
										padding: 14,
										borderRadius: 14,
										border: `1.5px solid ${ selectedService?.id === s.id ? 'var(--bc-color-primary)' : 'var(--bc-color-line)' }`,
										background: selectedService?.id === s.id ? 'var(--bc-color-primary-soft)' : 'var(--bc-color-surface)',
										cursor: 'pointer',
										display: 'flex',
										justifyContent: 'space-between',
										alignItems: 'center',
									} }
								>
									<span>{ s.name }</span>
									<PriceTag amount={ s.price } />
								</button>
							) ) }
						</div>
					</section>
				) }

				{ step === 2 && (
					<section>
						<h3 id="bc-booking-title" style={ { marginTop: 0 } }>۲. انتخاب تاریخ</h3>
						<div style={ { display: 'flex', gap: 8, overflowX: 'auto' } }>
							{ NEXT_7_DAYS.map( ( d, i ) => {
								const { weekday, day } = formatShortDate( d );
								return (
									<Chip key={ i } active={ selectedDateIdx === i } onClick={ () => setSelectedDateIdx( i ) }>
										<span style={ { display: 'flex', flexDirection: 'column', alignItems: 'center' } }>
											<span>{ weekday }</span>
											<span className="bc-numeric">{ day }</span>
										</span>
									</Chip>
								);
							} ) }
						</div>
					</section>
				) }

				{ step === 3 && (
					<section>
						<h3 id="bc-booking-title" style={ { marginTop: 0 } }>۳. انتخاب ساعت</h3>
						{ loading && <LoadingDots /> }
						{ ! loading && slots.length === 0 && <p style={ { color: 'var(--bc-color-ink-faint)' } }>زمان آزادی در این روز وجود ندارد.</p> }
						<div style={ { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 } }>
							{ slots.map( ( slot ) => (
								<Chip key={ slot.id } active={ selectedSlot?.id === slot.id } onClick={ () => setSelectedSlot( slot ) }>
									{ formatTime( new Date( slot.startAt.replace( ' ', 'T' ) ) ) }
								</Chip>
							) ) }
						</div>
					</section>
				) }

				{ step === 4 && selectedService && selectedSlot && (
					<section>
						<h3 id="bc-booking-title" style={ { marginTop: 0 } }>۴. بررسی و تأیید</h3>
						<div style={ { background: 'var(--bc-color-surface-tint)', borderRadius: 14, padding: 16, marginBottom: 16 } }>
							<p style={ { margin: '0 0 4px', fontWeight: 700 } }>{ selectedService.name }</p>
							<p style={ { margin: '0 0 4px', fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>
								{ formatShortDate( NEXT_7_DAYS[ selectedDateIdx ] ).weekday }، { formatTime( new Date( selectedSlot.startAt.replace( ' ', 'T' ) ) ) }
							</p>
							<PriceTag amount={ selectedService.price } />
						</div>
						<Button variant="primary" style={ { width: '100%' } } onClick={ handleConfirm } disabled={ loading }>
							{ loading ? 'در حال ثبت…' : 'تأیید نهایی رزرو' }
						</Button>
					</section>
				) }

				{ step === 5 && (
					<section style={ { textAlign: 'center', padding: '24px 0' } }>
						<div style={ { width: 56, height: 56, borderRadius: '50%', background: 'var(--bc-color-success-soft)', color: 'var(--bc-color-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 28 } }>✓</div>
						<h3 id="bc-booking-title">رزرو شما ثبت شد</h3>
						<p style={ { color: 'var(--bc-color-ink-soft)' } }>پس از تأیید نهایی متخصص، پیامک تأیید برای شما ارسال می‌شود.</p>
						<Button variant="primary" onClick={ onClose }>بازگشت</Button>
					</section>
				) }

				{ step < 4 && (
					<div style={ { display: 'flex', justifyContent: 'space-between', marginTop: 24 } }>
						<Button variant="ghost" onClick={ () => ( step === 1 ? onClose() : setStep( ( step - 1 ) as Step ) ) }>
							{ step === 1 ? 'انصراف' : 'قبلی' }
						</Button>
						<Button variant="primary" disabled={ ! canGoNext } onClick={ () => setStep( ( step + 1 ) as Step ) }>
							بعدی
						</Button>
					</div>
				) }
			</div>
		</Modal>
	);
}
