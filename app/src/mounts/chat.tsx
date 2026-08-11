import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '@/design-system';
import { ChatPanel } from '@/features/chat/ChatPanel';
import '@/design-system/tokens.generated.css';

/**
 * Same delegated-trigger pattern as mounts/booking.tsx and mounts/cart.tsx:
 * any `[data-bc-chat-open]` element (the profile page's "پیام" button)
 * opens this overlay, starting/resuming a conversation with the given
 * counterpart — works from any server-rendered page without that template
 * needing to know React exists. The dashboard's own "پیام‌ها" tab renders
 * <ChatPanel /> directly instead (no overlay needed there, it already has
 * a full-page canvas).
 */
function App() {
	const [ target, setTarget ] = useState<{ counterpartId: number; type: string } | null>( null );

	useEffect( () => {
		function onClick( e: MouseEvent ) {
			const trigger = ( e.target as HTMLElement )?.closest<HTMLElement>( '[data-bc-chat-open]' );
			if ( ! trigger ) return;
			e.preventDefault();
			const counterpartId = Number( trigger.dataset.counterpartId );
			if ( ! counterpartId ) return;
			setTarget( { counterpartId, type: trigger.dataset.chatType || 'pro' } );
		}
		document.addEventListener( 'click', onClick );
		return () => document.removeEventListener( 'click', onClick );
	}, [] );

	if ( ! target ) return null;

	return (
		<Modal open={ true } onClose={ () => setTarget( null ) } labelledBy="bc-chat-title">
			<div style={ { padding: 20, width: 'min(680px, 90vw)' } }>
				<h3 id="bc-chat-title" style={ { marginTop: 0 } }>پیام‌ها</h3>
				<ChatPanel initialCounterpartId={ target.counterpartId } initialType={ target.type } />
			</div>
		</Modal>
	);
}

const el = document.getElementById( 'bc-chat-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
