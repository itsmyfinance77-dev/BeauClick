import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HeaderSearch } from '@/features/search/HeaderSearch';
import '@/design-system/tokens.generated.css';

/**
 * Same delegated-trigger pattern as mounts/cart.tsx: any
 * `[data-bc-search-open]` element (the header's search icon chip) opens the
 * overlay — no page reload, global mount present on every page.
 */
function App() {
	const [ open, setOpen ] = useState( false );

	useEffect( () => {
		function onClick( e: MouseEvent ) {
			const target = e.target as HTMLElement;
			if ( target.closest( '[data-bc-search-open]' ) ) {
				setOpen( true );
			}
		}
		document.addEventListener( 'click', onClick );
		return () => document.removeEventListener( 'click', onClick );
	}, [] );

	return <HeaderSearch open={ open } onClose={ () => setOpen( false ) } />;
}

const el = document.getElementById( 'bc-header-search-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
