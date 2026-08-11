import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CartDrawer } from '@/features/cart/CartDrawer';
import { storeApi } from '@/lib/storeApi';
import { toPersianDigits } from '@/lib/format';
import '@/design-system/tokens.generated.css';

/**
 * Same delegated-trigger pattern as mounts/booking.tsx: any
 * `[data-bc-cart-open]` element (the header's cart icon chip) opens the
 * drawer, any `[data-bc-add-to-cart]` element (a product card's button)
 * adds that product and opens the drawer to confirm — no page reload
 * either way, matching the design handoff's "add-to-cart always opens the
 * cart drawer" interaction rule.
 */
function App() {
	const [ open, setOpen ] = useState( false );
	const [ refreshToken, setRefreshToken ] = useState( 0 );
	const [ pending, setPending ] = useState( false );

	useEffect( () => {
		storeApi.getCart().then( ( cart ) => updateBadge( cart.items_count ) ).catch( () => {} );

		function onClick( e: MouseEvent ) {
			const target = e.target as HTMLElement;

			if ( target.closest( '[data-bc-cart-open]' ) ) {
				setOpen( true );
				return;
			}

			const addTrigger = target.closest<HTMLElement>( '[data-bc-add-to-cart]' );
			if ( addTrigger && ! pending ) {
				e.preventDefault();
				const productId = Number( addTrigger.dataset.productId );
				if ( ! productId ) return;
				// Wholesale ("افزودن به سفارش عمده") triggers carry the
				// product's MOQ so the first add already meets it — adding
				// qty=1 to a wholesale-only product would otherwise
				// immediately trip TierPricingEngine::validate_moq() server-side.
				const quantity = addTrigger.dataset.quantity ? Number( addTrigger.dataset.quantity ) : 1;
				setPending( true );
				storeApi.addItem( productId, quantity )
					.then( ( cart ) => {
						updateBadge( cart.items_count );
						setRefreshToken( ( n ) => n + 1 );
						setOpen( true );
					} )
					.finally( () => setPending( false ) );
			}
		}

		document.addEventListener( 'click', onClick );
		return () => document.removeEventListener( 'click', onClick );
	}, [ pending ] );

	return <CartDrawer open={ open } onClose={ () => setOpen( false ) } refreshToken={ refreshToken } />;
}

function updateBadge( count: number ): void {
	const badge = document.getElementById( 'bc-cart-count' );
	if ( badge ) {
		badge.textContent = toPersianDigits( count );
	}
}

const el = document.getElementById( 'bc-cart-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
