import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ConversationList } from './ConversationList';
import { MessageThread } from './MessageThread';
import type { ChatMessage, ConversationSummary } from './types';

const LIST_POLL_MS = 15000;
const THREAD_POLL_MS = 4000;

/**
 * Custom tables + REST + client polling for v1 (architecture doc §15) —
 * no WebSockets. The conversation list refreshes every 15s (unread counts,
 * new threads); the open thread refreshes every 4s. Both intervals clear
 * on unmount/conversation switch so a closed panel never keeps polling.
 */
export function ChatPanel( { initialCounterpartId, initialType = 'pro' }: { initialCounterpartId?: number; initialType?: string } ) {
	const currentUserId = window.BeauClick?.currentUserId ?? 0;

	const [ conversations, setConversations ] = useState<ConversationSummary[] | null>( null );
	const [ activeId, setActiveId ] = useState<number | null>( null );
	const [ messages, setMessages ] = useState<ChatMessage[] | null>( null );
	const [ showThreadOnMobile, setShowThreadOnMobile ] = useState( false );

	function loadConversations() {
		api.get<ConversationSummary[]>( '/chat/conversations' ).then( setConversations ).catch( () => {} );
	}

	useEffect( () => {
		loadConversations();
		const interval = setInterval( loadConversations, LIST_POLL_MS );
		return () => clearInterval( interval );
	}, [] );

	useEffect( () => {
		if ( ! initialCounterpartId ) return;
		api.post<{ id: number }>( '/chat/conversations', { counterpart_id: initialCounterpartId, type: initialType } )
			.then( ( { id } ) => {
				setActiveId( id );
				setShowThreadOnMobile( true );
				loadConversations();
			} )
			.catch( () => {} );
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ initialCounterpartId, initialType ] );

	useEffect( () => {
		if ( ! activeId ) {
			setMessages( null );
			return;
		}
		setMessages( null );

		function load() {
			api.get<ChatMessage[]>( `/chat/conversations/${ activeId }/messages` ).then( setMessages ).catch( () => {} );
		}

		load();
		api.post( `/chat/conversations/${ activeId }/read` ).catch( () => {} );
		const interval = setInterval( load, THREAD_POLL_MS );
		return () => clearInterval( interval );
	}, [ activeId ] );

	const active = conversations?.find( ( c ) => c.id === activeId ) ?? null;

	async function send( body: string ) {
		if ( ! activeId ) return;
		const message = await api.post<ChatMessage>( `/chat/conversations/${ activeId }/messages`, { body } );
		setMessages( ( prev ) => ( prev ? [ ...prev, message ] : [ message ] ) );
		loadConversations();
	}

	return (
		<div className={ `bc-chat-panel${ showThreadOnMobile ? ' bc-chat-panel--thread-open' : '' }` }>
			<div className="bc-chat-panel__list">
				<ConversationList
					conversations={ conversations }
					activeId={ activeId }
					onSelect={ ( id ) => {
						setActiveId( id );
						setShowThreadOnMobile( true );
					} }
				/>
			</div>
			<div className="bc-chat-panel__thread">
				{ activeId ? (
					<MessageThread
						otherUserName={ active?.otherUserName ?? '' }
						messages={ messages }
						currentUserId={ currentUserId }
						onSend={ send }
						onBack={ () => setShowThreadOnMobile( false ) }
					/>
				) : (
					<div style={ { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--bc-color-ink-faint)', fontSize: 14 } }>
						یک گفتگو را انتخاب کنید
					</div>
				) }
			</div>
		</div>
	);
}
