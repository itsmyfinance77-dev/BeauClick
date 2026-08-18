import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { api } from '@/lib/api';
import { toPersianDigits } from '@/lib/format';
import '@/design-system/tokens.generated.css';

/**
 * V2.4 Step 24: same delegated-trigger + badge pattern as mounts/cart.tsx —
 * any `[data-bc-notifications-open]` element (the header's bell icon)
 * opens the panel, `#bc-notifications-count` is the badge DOM node kept in
 * sync outside React (server-rendered on first paint, updated here after
 * that). Refetches on window focus (cheap, no real-time infra) so the
 * badge doesn't go stale across a long-open tab without needing
 * WebSockets/polling infrastructure this step deliberately doesn't build.
 */
function App() {
	const [ open, setOpen ] = useState( false );

	useEffect( () => {
		refreshCount();

		function onClick( e: MouseEvent ) {
			if ( ( e.target as HTMLElement ).closest( '[data-bc-notifications-open]' ) ) {
				setOpen( true );
			}
		}
		function onFocus() {
			refreshCount();
		}
		function onCountChanged( e: Event ) {
			updateBadge( ( e as CustomEvent<number> ).detail );
		}

		document.addEventListener( 'click', onClick );
		window.addEventListener( 'focus', onFocus );
		window.addEventListener( 'bc:notifications-count', onCountChanged );
		return () => {
			document.removeEventListener( 'click', onClick );
			window.removeEventListener( 'focus', onFocus );
			window.removeEventListener( 'bc:notifications-count', onCountChanged );
		};
	}, [] );

	return <NotificationBell open={ open } onClose={ () => setOpen( false ) } />;
}

function refreshCount(): void {
	api.get<{ count: number }>( '/notifications/unread-count' ).then( ( { count } ) => updateBadge( count ) ).catch( () => {} );
}

function updateBadge( count: number ): void {
	const badge = document.getElementById( 'bc-notifications-count' );
	if ( badge ) {
		badge.textContent = toPersianDigits( count );
		badge.style.display = count > 0 ? '' : 'none';
	}
}

const el = document.getElementById( 'bc-notifications-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
