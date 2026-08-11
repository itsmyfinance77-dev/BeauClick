import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatShortDate, toPersianDigits } from '@/lib/format';
import { Button, LoadingDots, EmptyState } from '@/design-system';

interface MyReview {
	id: number;
	authorName: string;
	rating: number;
	body: string | null;
	response: string | null;
	createdAt: string;
}

export function ReviewsTab() {
	const [ reviews, setReviews ] = useState<MyReview[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ respondingId, setRespondingId ] = useState<number | null>( null );
	const [ responseText, setResponseText ] = useState( '' );
	const [ sending, setSending ] = useState( false );

	function load() {
		api.get<MyReview[]>( '/reviews/my' ).then( setReviews ).catch( () => setError( 'خطا در دریافت نظرات.' ) );
	}

	useEffect( load, [] );

	async function submitResponse( id: number ) {
		setSending( true );
		try {
			await api.post( `/reviews/${ id }/respond`, { response: responseText } );
			setRespondingId( null );
			setResponseText( '' );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ثبت پاسخ ناموفق بود.' );
		} finally {
			setSending( false );
		}
	}

	if ( error ) return <p style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! reviews ) return <LoadingDots />;
	if ( reviews.length === 0 ) return <EmptyState title="هنوز نظری ثبت نشده است." />;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>نظرات</h1>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 12 } }>
				{ reviews.map( ( r ) => (
					<div key={ r.id } className="bc-card" style={ { padding: 16 } }>
						<div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }>
							<strong>{ r.authorName }</strong>
							<span className="bc-rating bc-numeric"><span className="bc-rating__star" aria-hidden="true">★</span> { toPersianDigits( r.rating ) }</span>
						</div>
						<p style={ { margin: '4px 0 0', fontSize: 11, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
							{ formatShortDate( new Date( r.createdAt.replace( ' ', 'T' ) ) ).weekday }
						</p>
						{ r.body && <p style={ { margin: '8px 0 0', color: 'var(--bc-color-ink-soft)' } }>{ r.body }</p> }

						{ r.response ? (
							<div style={ { marginTop: 12, padding: 12, background: 'var(--bc-color-surface-tint)', borderRadius: 12 } }>
								<strong style={ { fontSize: 13 } }>پاسخ شما</strong>
								<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>{ r.response }</p>
							</div>
						) : respondingId === r.id ? (
							<div style={ { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } }>
								<textarea
									className="bc-input"
									rows={ 2 }
									value={ responseText }
									onChange={ ( e ) => setResponseText( e.target.value ) }
									placeholder="پاسخ خود را بنویسید…"
									style={ { resize: 'vertical' } }
								/>
								<div style={ { display: 'flex', gap: 8 } }>
									<Button variant="primary" disabled={ sending || ! responseText.trim() } onClick={ () => submitResponse( r.id ) }>ارسال پاسخ</Button>
									<Button variant="ghost" onClick={ () => setRespondingId( null ) }>انصراف</Button>
								</div>
							</div>
						) : (
							<Button variant="outline" style={ { marginTop: 12 } } onClick={ () => { setRespondingId( r.id ); setResponseText( '' ); } }>
								پاسخ به نظر
							</Button>
						) }
					</div>
				) ) }
			</div>
		</div>
	);
}
