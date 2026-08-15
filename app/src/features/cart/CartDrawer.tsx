import { useEffect, useState } from 'react';
import { Modal, Button, EmptyState, LoadingDots } from '@/design-system';
import { storeApi, storeApiAmount, type StoreCart } from '@/lib/storeApi';
import { formatToman, toPersianDigits } from '@/lib/format';
import emptyIllustration from '@/assets/mockups/empty-illustration.svg';

export interface CartDrawerProps {
	open: boolean;
	onClose: () => void;
	/** Bumped by the mount script whenever an "add to cart" trigger fires elsewhere on the page, so the drawer refetches without the two modules needing a shared store. */
	refreshToken: number;
}

/**
 * List -> review -> success per the design handoff's cart drawer, using
 * WooCommerce's own Store API for every operation — no custom cart table,
 * no reimplementing quantity/stock/pricing logic WooCommerce already owns.
 * "تکمیل خرید" hands off to the real (now classic-shortcode, per the
 * architectural review) WooCommerce Checkout page rather than trying to
 * build address/payment entry inside the drawer.
 */
export function CartDrawer( { open, onClose, refreshToken }: CartDrawerProps ) {
	const [ cart, setCart ] = useState<StoreCart | null>( null );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		if ( ! open ) return;
		setLoading( true );
		storeApi.getCart()
			.then( setCart )
			.catch( () => setError( 'خطا در دریافت سبد خرید.' ) )
			.finally( () => setLoading( false ) );
	}, [ open, refreshToken ] );

	async function updateQty( key: string, quantity: number ) {
		setLoading( true );
		try {
			const updated = quantity > 0 ? await storeApi.updateItem( key, quantity ) : await storeApi.removeItem( key );
			setCart( updated );
		} catch {
			setError( 'به‌روزرسانی سبد خرید ناموفق بود.' );
		} finally {
			setLoading( false );
		}
	}

	const minorUnit = cart?.totals.currency_minor_unit ?? 0;

	return (
		<Modal open={ open } onClose={ onClose } variant="drawer-end" labelledBy="bc-cart-title">
			<div style={ { padding: 24, display: 'flex', flexDirection: 'column', height: '100%' } }>
				<h2 id="bc-cart-title" style={ { marginTop: 0 } }>سبد خرید</h2>

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
				{ loading && <LoadingDots /> }

				{ ! loading && cart && cart.items.length === 0 && (
					<EmptyState title="سبد خرید شما خالی است." illustration={ emptyIllustration } />
				) }

				{ ! loading && cart && cart.items.length > 0 && (
					<>
						<div style={ { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 } }>
							{ cart.items.map( ( item ) => (
								<div key={ item.key } className="bc-card" style={ { padding: 12, display: 'flex', gap: 12, alignItems: 'center' } }>
									<div style={ { flex: 1 } }>
										<strong style={ { fontSize: 14 } }>{ item.name }</strong>
										<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' } } className="bc-numeric">
											{ formatToman( storeApiAmount( item.prices.price, minorUnit ) ) } تومان
										</p>
									</div>
									<div style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
										<button type="button" className="bc-btn bc-btn--ghost" onClick={ () => updateQty( item.key, item.quantity - 1 ) } aria-label="کاهش">−</button>
										<span className="bc-numeric">{ toPersianDigits( item.quantity ) }</span>
										<button type="button" className="bc-btn bc-btn--ghost" onClick={ () => updateQty( item.key, item.quantity + 1 ) } aria-label="افزایش">+</button>
									</div>
								</div>
							) ) }
						</div>

						<div style={ { borderTop: '1px solid var(--bc-color-line)', paddingTop: 16, marginTop: 16 } }>
							<div style={ { display: 'flex', justifyContent: 'space-between', marginBottom: 16 } }>
								<span>جمع کل</span>
								<strong className="bc-numeric">{ formatToman( storeApiAmount( cart.totals.total_price, minorUnit ) ) } تومان</strong>
							</div>
							<Button
								variant="primary"
								style={ { width: '100%' } }
								onClick={ () => {
									if ( window.BeauClick?.checkoutUrl ) {
										window.location.href = window.BeauClick.checkoutUrl;
									}
								} }
							>
								تکمیل خرید
							</Button>
						</div>
					</>
				) }
			</div>
		</Modal>
	);
}
