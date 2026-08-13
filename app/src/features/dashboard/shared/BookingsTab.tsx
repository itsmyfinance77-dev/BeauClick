import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate, formatTime } from '@/lib/format';
import { Button, LoadingDots, EmptyState } from '@/design-system';
import { ReviewForm } from '@/features/reviews/ReviewForm';

interface FullBooking {
	id: number;
	providerId: number;
	customerId: number;
	serviceId: number | null;
	slotStart: string;
	slotEnd: string;
	status: string;
}

const STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار پرداخت',
	confirmed: 'تأیید‌شده',
	completed: 'انجام‌شده',
	cancelled: 'لغو‌شده',
	no_show: 'عدم حضور',
};

export function BookingsTab() {
	const [ bookings, setBookings ] = useState<FullBooking[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ busyId, setBusyId ] = useState<number | null>( null );
	const [ reviewingId, setReviewingId ] = useState<number | null>( null );
	const [ reviewedIds, setReviewedIds ] = useState<Set<number>>( new Set() );
	const currentUserId = window.BeauClick?.currentUserId ?? 0;

	function load() {
		api.get<FullBooking[]>( '/booking/bookings' ).then( setBookings ).catch( () => setError( 'خطا در دریافت رزروها.' ) );
	}

	useEffect( load, [] );

	async function act( id: number, action: 'cancel' | 'no-show' ) {
		setBusyId( id );
		try {
			await api.post( `/booking/bookings/${ id }/${ action }` );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'خطا در انجام عملیات.' );
		} finally {
			setBusyId( null );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! bookings ) return <LoadingDots />;
	if ( bookings.length === 0 ) return <EmptyState title="هنوز رزروی ثبت نشده است." />;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>رزروها</h1>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
				{ bookings.map( ( b ) => (
					<div key={ b.id }>
						<div className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }>
							<div>
								<strong className="bc-numeric">
									{ formatFullJalaliDate( new Date( b.slotStart.replace( ' ', 'T' ) ) ) }، { formatTime( new Date( b.slotStart.replace( ' ', 'T' ) ) ) }
								</strong>
								<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>{ STATUS_LABELS[ b.status ] ?? b.status }</p>
							</div>
							<div style={ { display: 'flex', gap: 8 } }>
								{ [ 'pending', 'confirmed' ].includes( b.status ) && (
									<Button variant="outline" disabled={ busyId === b.id } onClick={ () => act( b.id, 'cancel' ) }>
										لغو رزرو
									</Button>
								) }
								{ /* Provider-only: this list only ever contains bookings the current
								     user owns one way or the other (customer OR provider) -- if it's
								     not their own customerId, they must be the provider. */ }
								{ 'confirmed' === b.status && b.customerId !== currentUserId && new Date( b.slotEnd.replace( ' ', 'T' ) ) < new Date() && (
									<Button variant="outline" disabled={ busyId === b.id } onClick={ () => act( b.id, 'no-show' ) }>
										ثبت عدم حضور مشتری
									</Button>
								) }
							</div>
							{ 'completed' === b.status && b.customerId === currentUserId && (
								reviewedIds.has( b.id )
									? <span style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>نظر شما ثبت شد</span>
									: <Button variant="outline" onClick={ () => setReviewingId( reviewingId === b.id ? null : b.id ) }>
										{ reviewingId === b.id ? 'انصراف' : 'ثبت نظر' }
									</Button>
							) }
						</div>
						{ reviewingId === b.id && (
							<ReviewForm
								bookingId={ b.id }
								onSubmitted={ () => {
									setReviewedIds( ( prev ) => new Set( prev ).add( b.id ) );
									setReviewingId( null );
								} }
							/>
						) }
					</div>
				) ) }
			</div>
		</div>
	);
}
