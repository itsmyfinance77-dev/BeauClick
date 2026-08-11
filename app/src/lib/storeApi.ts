/**
 * WooCommerce Store API client (wp-json/wc/store/v1) — the native, public
 * REST API for cart operations, separate from our own beauclick/v1 (a
 * different nonce scheme: Store API requires a `Nonce` request header
 * whose value comes from the `Nonce` response header of a prior request,
 * not the wp_rest nonce beauclick/v1 uses). No custom cart backend here —
 * this is exactly WooCommerce's own cart, used as-is (architecture doc §6).
 */

let cartNonce = '';

export interface StoreCartItem {
	key: string;
	id: number;
	name: string;
	quantity: number;
	prices: { price: string; regular_price: string; currency_minor_unit: number };
	images: { src: string }[];
}

export interface StoreCart {
	items: StoreCartItem[];
	items_count: number;
	totals: { total_price: string; currency_minor_unit: number };
}

function storeApiUrl( path: string ): string {
	const restUrl = window.BeauClick?.restUrl ?? '/wp-json/beauclick/v1';
	const base = restUrl.replace( /beauclick\/v1.*$/, '' ); // Same host/index.php?rest_route= form as beauclick/v1, different namespace.
	return `${ base }wc/store/v1${ path }`;
}

async function storeRequest<T>( path: string, options: RequestInit = {} ): Promise<T> {
	const res = await fetch( storeApiUrl( path ), {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...( cartNonce ? { Nonce: cartNonce } : {} ),
			...options.headers,
		},
		credentials: 'same-origin',
	} );

	const freshNonce = res.headers.get( 'Nonce' );
	if ( freshNonce ) {
		cartNonce = freshNonce;
	}

	if ( ! res.ok ) {
		const body = await res.json().catch( () => ( {} ) );
		throw new Error( body?.message ?? res.statusText );
	}

	return res.json();
}

export const storeApi = {
	getCart: () => storeRequest<StoreCart>( '/cart' ),
	addItem: ( productId: number, quantity = 1 ) =>
		storeRequest<StoreCart>( '/cart/add-item', { method: 'POST', body: JSON.stringify( { id: productId, quantity } ) } ),
	updateItem: ( key: string, quantity: number ) =>
		storeRequest<StoreCart>( '/cart/update-item', { method: 'POST', body: JSON.stringify( { key, quantity } ) } ),
	removeItem: ( key: string ) =>
		storeRequest<StoreCart>( '/cart/remove-item', { method: 'POST', body: JSON.stringify( { key } ) } ),
};

/** Store API prices are integer minor units (e.g. price * 100 for 2-decimal currencies) — this converts back to a real amount for our formatToman()/PriceTag helpers. */
export function storeApiAmount( minorAmount: string, minorUnit: number ): number {
	return Number( minorAmount ) / 10 ** minorUnit;
}
