import { useEffect, useRef, useState } from 'react';
import { formatTime } from '@/lib/format';
import { Button, Input, LoadingDots } from '@/design-system';
import { ApiError } from '@/lib/api';
import type { ChatMessage } from './types';

export function MessageThread( {
	otherUserName,
	messages,
	currentUserId,
	onSend,
	onBack,
}: {
	otherUserName: string;
	messages: ChatMessage[] | null;
	currentUserId: number;
	onSend: ( body: string ) => Promise<void>;
	onBack?: () => void;
} ) {
	const [ text, setText ] = useState( '' );
	const [ sending, setSending ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );
	const bottomRef = useRef<HTMLDivElement>( null );

	useEffect( () => {
		bottomRef.current?.scrollIntoView( { block: 'end' } );
	}, [ messages ] );

	async function submit( e: React.FormEvent ) {
		e.preventDefault();
		const body = text.trim();
		if ( ! body || sending ) return;
		setSending( true );
		setError( null );
		try {
			await onSend( body );
			setText( '' );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ارسال پیام ناموفق بود.' );
		} finally {
			setSending( false );
		}
	}

	return (
		<div className="bc-chat-thread">
			<div className="bc-chat-thread__header">
				{ onBack && <button type="button" className="bc-icon-chip" onClick={ onBack } aria-label="بازگشت">→</button> }
				<strong>{ otherUserName || 'کاربر' }</strong>
			</div>

			<div className="bc-chat-thread__messages">
				{ ! messages && <LoadingDots /> }
				{ messages?.map( ( m ) => (
					<div key={ m.id } className={ `bc-chat-bubble${ m.senderId === currentUserId ? ' bc-chat-bubble--mine' : '' }` }>
						<p style={ { margin: 0 } }>{ m.body }</p>
						<span className="bc-numeric" style={ { fontSize: 10, opacity: 0.7 } }>{ formatTime( new Date( m.createdAt.replace( ' ', 'T' ) ) ) }</span>
					</div>
				) ) }
				<div ref={ bottomRef } />
			</div>

			{ error && <p style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: '0 12px' } }>{ error }</p> }

			<form onSubmit={ submit } className="bc-chat-thread__composer">
				<Input placeholder="پیام خود را بنویسید…" value={ text } onChange={ ( e ) => setText( e.target.value ) } disabled={ sending } />
				<Button variant="primary" type="submit" disabled={ sending || ! text.trim() }>ارسال</Button>
			</form>
		</div>
	);
}
