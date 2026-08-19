import { api } from '@/lib/api';

/**
 * V2.4 Step 23. No React tree here -- a provider profile page's own
 * server-rendered "افزودن به علاقه‌مندی‌ها" button already carries its
 * correct initial pressed state (`data-wishlisted`) and providerId
 * (`data-provider-id`); this just wires a delegated click listener that
 * toggles it via the real REST endpoint, the same imperative-DOM-update
 * style `mounts/notification-bell.tsx` already uses for its own badge,
 * rather than mounting a React root for a single stateless toggle.
 */
document.addEventListener( 'click', ( e ) => {
	const button = ( e.target as HTMLElement ).closest<HTMLElement>( '[data-bc-wishlist-toggle]' );
	if ( ! button ) return;

	const providerId = Number( button.dataset.providerId );
	if ( ! providerId ) return;

	const wasWishlisted = button.dataset.wishlisted === 'true';
	const request = wasWishlisted
		? api.del<{ wishlisted: boolean }>( `/marketplace/wishlist/${ providerId }` )
		: api.post<{ wishlisted: boolean }>( `/marketplace/wishlist/${ providerId }` );

	setWishlisted( button, ! wasWishlisted );
	request.catch( () => setWishlisted( button, wasWishlisted ) );
} );

function setWishlisted( button: HTMLElement, wishlisted: boolean ): void {
	button.dataset.wishlisted = wishlisted ? 'true' : 'false';
	button.setAttribute( 'aria-pressed', wishlisted ? 'true' : 'false' );
	button.classList.toggle( 'bc-wishlist-btn--active', wishlisted );

	const label = button.querySelector( '[data-bc-wishlist-label]' );
	if ( label ) {
		label.textContent = wishlisted ? 'در علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی‌ها';
	}

	const icon = button.querySelector( '[aria-hidden="true"]' );
	if ( icon ) {
		icon.textContent = wishlisted ? '♥' : '♡';
	}
}
