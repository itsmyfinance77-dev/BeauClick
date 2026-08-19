import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatToman } from '@/lib/format';
import { LoadingDots, EmptyState, Button } from '@/design-system';

interface WishlistItem {
	id: number;
	name: string | null;
	available: boolean;
	cityId: number | null;
	priceFrom: number | null;
	rating: number;
}

export function WishlistTab() {
	const [ items, setItems ] = useState<WishlistItem[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		api.get<WishlistItem[]>( '/marketplace/wishlist' ).then( setItems ).catch( () => setError( 'خطا در دریافت علاقه‌مندی‌ها.' ) );
	}, [] );

	const remove = ( providerId: number ) => {
		setItems( ( prev ) => ( prev ? prev.filter( ( i ) => i.id !== providerId ) : prev ) );
		api.del( `/marketplace/wishlist/${ providerId }` ).catch( () => {
			// A failed removal is re-fetched from the server rather than
			// silently trusted -- the optimistic removal above could
			// otherwise leave the UI showing a stale, wrong state.
			api.get<WishlistItem[]>( '/marketplace/wishlist' ).then( setItems ).catch( () => undefined );
		} );
	};

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! items ) return <LoadingDots />;
	if ( items.length === 0 ) return <EmptyState title="هنوز متخصصی را به علاقه‌مندی‌ها اضافه نکرده‌اید." />;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>علاقه‌مندی‌های من</h1>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
				{ items.map( ( item ) => (
					<div key={ item.id } className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }>
						<div>
							{ item.available ? (
								<a href={ `/?p=${ item.id }` } style={ { fontWeight: 600, color: 'inherit', textDecoration: 'none' } }>{ item.name }</a>
							) : (
								<>
									<span style={ { fontWeight: 600, color: 'var(--bc-color-ink-faint)' } }>{ item.name ?? 'متخصص' }</span>
									<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-error)' } }>این پروفایل دیگر در دسترس نیست.</p>
								</>
							) }
						</div>
						<div style={ { display: 'flex', alignItems: 'center', gap: 12 } }>
							{ item.available && null !== item.priceFrom && (
								<span className="bc-price bc-numeric">
									<span className="bc-price__amount">{ formatToman( item.priceFrom ) }</span>
									<span className="bc-price__unit">تومان</span>
								</span>
							) }
							<Button variant="ghost" onClick={ () => remove( item.id ) } aria-label="حذف از علاقه‌مندی‌ها">حذف</Button>
						</div>
					</div>
				) ) }
			</div>
		</div>
	);
}
