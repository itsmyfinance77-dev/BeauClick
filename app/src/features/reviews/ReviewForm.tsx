import { useState } from 'react';
import { Button } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import { toPersianDigits } from '@/lib/format';

/**
 * Only ever shown for a booking the viewer owns as the customer that has
 * actually completed (BookingsTab gates on that) — the server independently
 * re-verifies both facts (architecture doc §8's "verified booking
 * indicator, enforced at the data layer") and rejects anything else, so
 * this form has no way to produce a review the backend wouldn't have
 * accepted through some other path.
 */
export function ReviewForm( { bookingId, onSubmitted }: { bookingId: number; onSubmitted: () => void } ) {
	const [ rating, setRating ] = useState( 5 );
	const [ body, setBody ] = useState( '' );
	const [ sending, setSending ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	async function submit( e: React.FormEvent ) {
		e.preventDefault();
		setSending( true );
		setError( null );
		try {
			await api.post( '/reviews', { booking_id: bookingId, rating, body } );
			onSubmitted();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ثبت نظر ناموفق بود.' );
		} finally {
			setSending( false );
		}
	}

	return (
		<form onSubmit={ submit } className="bc-card" style={ { padding: 12, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } }>
			<div style={ { display: 'flex', gap: 4 } }>
				{ [ 1, 2, 3, 4, 5 ].map( ( n ) => (
					<button
						key={ n }
						type="button"
						onClick={ () => setRating( n ) }
						aria-label={ `${ toPersianDigits( n ) } ستاره` }
						style={ { background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: n <= rating ? 'var(--bc-color-warning, #e5a000)' : 'var(--bc-color-line)', padding: 0 } }
					>
						★
					</button>
				) ) }
			</div>
			<textarea
				aria-label="متن نظر"
				value={ body }
				onChange={ ( e ) => setBody( e.target.value ) }
				placeholder="تجربه‌تون رو بنویسید (اختیاری)"
				rows={ 3 }
				className="bc-input"
				style={ { resize: 'vertical' } }
			/>
			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0 } }>{ error }</p> }
			<Button variant="primary" type="submit" disabled={ sending }>{ sending ? 'در حال ثبت…' : 'ثبت نظر' }</Button>
		</form>
	);
}
