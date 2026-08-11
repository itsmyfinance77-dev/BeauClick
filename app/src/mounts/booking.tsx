import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookingModal } from '@/features/booking/BookingModal';
import '@/design-system/tokens.generated.css';

/**
 * The modal itself has nowhere fixed to live in the server-rendered
 * markup — instead, any element carrying `data-bc-book-trigger` (a
 * provider card's "رزرو نوبت" button, a service row's "رزرو" button) opens
 * it via a delegated click listener, passing providerId/serviceId through
 * data attributes. This lets plain PHP templates trigger the React modal
 * without each template needing to know React exists.
 */
function App() {
	const [ target, setTarget ] = useState<{ providerId: number; serviceId?: number } | null>( null );

	useEffect( () => {
		function onClick( e: MouseEvent ) {
			const trigger = ( e.target as HTMLElement )?.closest<HTMLElement>( '[data-bc-book-trigger]' );
			if ( ! trigger ) return;
			e.preventDefault();
			const providerId = Number( trigger.dataset.providerId );
			const serviceId = trigger.dataset.serviceId ? Number( trigger.dataset.serviceId ) : undefined;
			if ( providerId ) setTarget( { providerId, serviceId } );
		}
		document.addEventListener( 'click', onClick );
		return () => document.removeEventListener( 'click', onClick );
	}, [] );

	if ( ! target ) return null;

	return (
		<BookingModal
			open={ true }
			onClose={ () => setTarget( null ) }
			providerId={ target.providerId }
			initialServiceId={ target.serviceId }
		/>
	);
}

const el = document.getElementById( 'bc-booking-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
