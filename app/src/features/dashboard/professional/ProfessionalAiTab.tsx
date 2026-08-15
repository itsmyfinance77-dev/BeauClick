import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Input, LoadingDots } from '@/design-system';
import { api, ApiError } from '@/lib/api';

interface ProfessionalAiMessage {
	id: number;
	conversationId: number;
	senderId: number | null;
	body: string;
	createdAt: string;
}

const QUICK_SUGGESTIONS = [ 'رزروهای من چطوره؟', 'کدوم خدمت من محبوب‌تره؟', 'وضعیت مالی من چیه؟', 'کمپین‌های فعال من کدومه؟' ];

/**
 * V2.3 Step 19 — the professional-facing read-only AI insight surface.
 * Deliberately a plain in-tab panel, not a Modal/drawer like the
 * customer-facing AiPanel — this lives inside the dashboard's own content
 * area like every other tab (RevenueTab, AnalyticsTab), not as a floating
 * overlay, since a professional working through their own data wants it
 * alongside the rest of the dashboard, not interrupting it.
 *
 * Reads/writes `/ai/professional/messages` — a wholly separate endpoint and
 * conversation from the customer-facing `/ai/messages` (see the backend's
 * own migration docblock for why). This component never computes or infers
 * any business figure itself; every number in a reply came from the
 * server's own real ledger/analytics/campaign data.
 */
export function ProfessionalAiTab() {
	const [ messages, setMessages ] = useState<ProfessionalAiMessage[] | null>( null );
	const [ text, setText ] = useState( '' );
	const [ sending, setSending ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );
	const [ noProfile, setNoProfile ] = useState( false );
	const bottomRef = useRef<HTMLDivElement>( null );

	const currentUserId = window.BeauClick?.currentUserId ?? 0;

	useEffect( () => {
		api
			.get<ProfessionalAiMessage[]>( '/ai/professional/messages' )
			.then( setMessages )
			.catch( ( e ) => {
				if ( e instanceof ApiError && e.status === 404 ) {
					setNoProfile( true );
					return;
				}
				setError( e instanceof ApiError ? e.message : 'خطا در دریافت گفتگو.' );
			} );
	}, [] );

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
			const result = await api.post<{ userMessage: ProfessionalAiMessage; assistantMessage: ProfessionalAiMessage }>( '/ai/professional/messages', { body: trimmed } );
			setMessages( ( prev ) => [ ...( prev ?? [] ), result.userMessage, result.assistantMessage ] );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ارسال پیام ناموفق بود.' );
		} finally {
			setSending( false );
		}
	}

	if ( noProfile ) {
		return <p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>این بخش پس از ساخت پروفایل متخصص یا کسب‌وکار شما در دسترس خواهد بود.</p>;
	}

	return (
		<div style={ { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)', maxHeight: 640 } }>
			<div style={ { marginBottom: 12 } }>
				<h1 style={ { fontSize: 22, margin: 0 } }>دستیار هوشمند حرفه‌ای‌ها</h1>
				<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', marginTop: 4, marginBottom: 0 } }>
					این دستیار فقط بر اساس داده‌های واقعی خودِ شما پاسخ می‌دهد — صرفاً اطلاعاتی و فقط‌خواندنی است و هیچ تغییری در رزرو، قیمت، کمپین یا حساب شما ایجاد نمی‌کند.
					پاسخ‌ها ممکن است توسط هوش مصنوعی تولید شوند و برخی اطلاعات ممکن است هنوز در دسترس نباشد.
				</p>
			</div>

			<div className="bc-card" style={ { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } }>
				{ ! messages && <LoadingDots /> }

				{ messages?.length === 0 && (
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
							<div className={ `bc-chat-bubble${ m.senderId === currentUserId ? ' bc-chat-bubble--mine' : '' }` }>
								<p style={ { margin: 0, whiteSpace: 'pre-line' } }>{ m.body }</p>
							</div>
						</div>
					</div>
				) ) }

				{ sending && (
					<div style={ { display: 'flex', gap: 8, alignItems: 'center' } }>
						<div style={ { width: 26, height: 26, borderRadius: '50%', background: 'var(--bc-gradient-brand)', flexShrink: 0 } } />
						<LoadingDots />
					</div>
				) }

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
				<div ref={ bottomRef } />
			</div>

			<form
				onSubmit={ ( e ) => { e.preventDefault(); send( text ); } }
				style={ { display: 'flex', gap: 8, padding: '12px 0 0' } }
			>
				<Input aria-label="پیام به دستیار حرفه‌ای‌ها" placeholder="مثلاً: رزروهای من چطوره؟" value={ text } onChange={ ( e ) => setText( e.target.value ) } disabled={ sending } />
				<Button variant="primary" type="submit" disabled={ sending || ! text.trim() }>ارسال</Button>
			</form>
		</div>
	);
}
