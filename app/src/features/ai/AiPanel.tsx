import { useEffect, useRef, useState } from 'react';
import { Modal, Button, Chip, Input, LoadingDots } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import { RecommendationCard } from './RecommendationCard';
import type { AiMessage } from './types';

const QUICK_SUGGESTIONS = [ 'میکاپ عروس', 'رنگ مو', 'مراقبت پوست', 'ناخن' ];

/**
 * Right-side panel (full-screen on mobile), per design handoff §9. Unlike
 * the prototype's simulated 700ms typing delay, the "typing" indicator here
 * reflects a real pending request to /ai/messages — AI conversations are
 * synchronous request/response (architecture doc §16), no polling.
 */
export function AiPanel( { open, onClose }: { open: boolean; onClose: () => void } ) {
	const [ messages, setMessages ] = useState<AiMessage[] | null>( null );
	const [ text, setText ] = useState( '' );
	const [ sending, setSending ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );
	const bottomRef = useRef<HTMLDivElement>( null );

	const isLoggedIn = window.BeauClick?.isLoggedIn ?? false;
	const currentUserId = window.BeauClick?.currentUserId ?? 0;

	useEffect( () => {
		if ( ! open || ! isLoggedIn ) return;
		api.get<AiMessage[]>( '/ai/messages' ).then( setMessages ).catch( () => setError( 'خطا در دریافت گفتگو.' ) );
	}, [ open, isLoggedIn ] );

	useEffect( () => {
		bottomRef.current?.scrollIntoView( { block: 'end' } );
	}, [ messages, sending ] );

	async function send( body: string ) {
		const trimmed = body.trim();
		if ( ! trimmed || sending ) return;
		setSending( true );
		setError( null );
		setText( '' );
		try {
			const result = await api.post<{ userMessage: AiMessage; assistantMessage: AiMessage }>( '/ai/messages', { body: trimmed } );
			setMessages( ( prev ) => [ ...( prev ?? [] ), result.userMessage, result.assistantMessage ] );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ارسال پیام ناموفق بود.' );
		} finally {
			setSending( false );
		}
	}

	return (
		<Modal open={ open } onClose={ onClose } variant="drawer-end" labelledBy="bc-ai-title">
			<div style={ { display: 'flex', flexDirection: 'column', height: '100%' } }>
				<div style={ { background: 'var(--bc-gradient-brand)', color: 'white', padding: '20px 24px' } }>
					<h2 id="bc-ai-title" style={ { margin: 0, fontSize: 18 } }>دستیار هوشمند زیبایی</h2>
					<p style={ { margin: '4px 0 0', fontSize: 13, opacity: 0.85 } }>بگو دنبال چی هستی، بهترین گزینه‌ها رو نشونت می‌دم.</p>
				</div>

				<div style={ { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 } }>
					{ ! isLoggedIn && (
						<div className="bc-empty-state">
							<p className="bc-empty-state__title">برای گفتگو با دستیار هوشمند ابتدا وارد حساب کاربری خود شوید.</p>
							<a href={ `/wp-login.php?redirect_to=${ encodeURIComponent( window.location.href ) }` } className="bc-btn bc-btn--primary">ورود</a>
						</div>
					) }

					{ isLoggedIn && ! messages && <LoadingDots /> }

					{ isLoggedIn && messages?.length === 0 && (
						<div style={ { display: 'flex', flexWrap: 'wrap', gap: 8 } }>
							{ QUICK_SUGGESTIONS.map( ( s ) => (
								<Chip key={ s } onClick={ () => send( s ) }>{ s }</Chip>
							) ) }
						</div>
					) }

					{ messages?.map( ( m ) => (
						<div key={ m.id } style={ { display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: m.senderId === currentUserId ? 'row-reverse' : 'row' } }>
							{ ! m.senderId && <div style={ { width: 26, height: 26, borderRadius: '50%', background: 'var(--bc-gradient-brand)', flexShrink: 0 } } /> }
							<div style={ { maxWidth: '80%' } }>
								<div
									className={ `bc-chat-bubble${ m.senderId === currentUserId ? ' bc-chat-bubble--mine' : '' }` }
									style={ { alignSelf: 'auto' } }
								>
									<p style={ { margin: 0 } }>{ m.body }</p>
								</div>
								{ m.recommendations.length > 0 && (
									<div style={ { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } }>
										{ m.recommendations.map( ( rec ) => <RecommendationCard key={ `${ rec.type }-${ rec.id }` } rec={ rec } /> ) }
									</div>
								) }
							</div>
						</div>
					) ) }

					{ sending && (
						<div style={ { display: 'flex', gap: 8, alignItems: 'center' } }>
							<div style={ { width: 26, height: 26, borderRadius: '50%', background: 'var(--bc-gradient-brand)', flexShrink: 0 } } />
							<LoadingDots />
						</div>
					) }

					{ error && <p style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
					<div ref={ bottomRef } />
				</div>

				{ isLoggedIn && (
					<form
						onSubmit={ ( e ) => { e.preventDefault(); send( text ); } }
						style={ { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid var(--bc-color-line)' } }
					>
						<Input placeholder="بپرس چی نیاز داری…" value={ text } onChange={ ( e ) => setText( e.target.value ) } disabled={ sending } />
						<Button variant="primary" type="submit" disabled={ sending || ! text.trim() }>ارسال</Button>
					</form>
				) }
			</div>
		</Modal>
	);
}
