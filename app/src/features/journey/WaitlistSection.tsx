import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Badge, LoadingDots } from '@/design-system';
import { formatFullJalaliDate } from '@/lib/format';

interface WaitlistEntry {
	id: number;
	providerId: number;
	serviceId: number | null;
	preferredDate: string | null;
	status: 'waiting' | 'cancelled' | 'expired';
	createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
	waiting: 'در انتظار',
	cancelled: 'لغوشده',
	expired: 'منقضی‌شده',
};

function jalaliDateOnly( isoDate: string | null ): string {
	if ( ! isoDate ) return 'هر زمان';
	const [ y, m, d ] = isoDate.split( '-' ).map( Number );
	if ( [ y, m, d ].some( Number.isNaN ) ) return isoDate;
	return formatFullJalaliDate( new Date( y, m - 1, d ) ).replace( /^.+، /, '' );
}

/** V2.1 Step 10 (BOOK-06) — the customer's own view of their waitlist entries; join happens from BookingModal when no slots match. */
export function WaitlistSection() {
	const [ entries, setEntries ] = useState<WaitlistEntry[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ busyId, setBusyId ] = useState<number | null>( null );

	function load() {
		api.get<WaitlistEntry[]>( '/booking/waitlist/mine' ).then( setEntries ).catch( () => setError( 'خطا در دریافت لیست انتظار.' ) );
	}

	useEffect( load, [] );

	async function cancel( id: number ) {
		setBusyId( id );
		try {
			await api.post( `/booking/waitlist/${ id }/cancel` );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'لغو ناموفق بود.' );
		} finally {
			setBusyId( null );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! entries ) return <LoadingDots />;

	const waiting = entries.filter( ( e ) => 'waiting' === e.status );
	if ( waiting.length === 0 ) return null; // Nothing waiting -- no need to take up space with an empty section.

	return (
		<section>
			<h2 style={ { fontSize: 16, marginBottom: 10 } }>لیست انتظار من</h2>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
				{ waiting.map( ( e ) => (
					<div key={ e.id } className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }>
						<div>
							<Badge variant="warning">{ STATUS_LABELS[ e.status ] }</Badge>
							<p style={ { margin: '6px 0 0', fontSize: 13 } } className="bc-numeric">
								تاریخ درخواستی: { jalaliDateOnly( e.preferredDate ) }
							</p>
						</div>
						<Button variant="outline" disabled={ busyId === e.id } onClick={ () => cancel( e.id ) }>
							{ busyId === e.id ? 'در حال لغو…' : 'لغو' }
						</Button>
					</div>
				) ) }
			</div>
		</section>
	);
}
