import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WishlistTab } from './WishlistTab';

const ITEMS = [
	{ id: 1, name: 'سالن آرایش الف', available: true, cityId: 1, priceFrom: 500000, rating: 4.5 },
	{ id: 2, name: 'سالن آرایش ب', available: false, cityId: null, priceFrom: null, rating: 0 },
];

function mockFetch( items: unknown = ITEMS, deleteOk = true ) {
	vi.stubGlobal(
		'fetch',
		vi.fn( ( input: RequestInfo | URL, init?: RequestInit ) => {
			const url = String( input );
			if ( init?.method === 'DELETE' ) {
				return Promise.resolve( { ok: deleteOk, json: async () => ( { data: { wishlisted: false }, meta: {}, error: null } ) } as Response );
			}
			if ( url.includes( '/marketplace/wishlist' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: items, meta: {}, error: null } ) } as Response );
			}
			return Promise.resolve( { ok: false, json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا' } } ) } as Response );
		} )
	);
}

describe( 'WishlistTab', () => {
	afterEach( () => vi.unstubAllGlobals() );

	it( 'fetches and renders the real wishlist, with an available and an unavailable item shown differently', async () => {
		mockFetch();
		render( <WishlistTab /> );

		expect( await screen.findByText( 'سالن آرایش الف' ) ).toBeTruthy();
		expect( screen.getByText( 'سالن آرایش ب' ) ).toBeTruthy();
		expect( screen.getByText( 'این پروفایل دیگر در دسترس نیست.' ) ).toBeTruthy();
	} );

	it( 'shows a real empty state for a genuinely empty wishlist, not a blank panel', async () => {
		mockFetch( [] );
		render( <WishlistTab /> );

		expect( await screen.findByText( 'هنوز متخصصی را به علاقه‌مندی‌ها اضافه نکرده‌اید.' ) ).toBeTruthy();
	} );

	it( 'shows a Persian error message when fetching fails', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( { ok: false, json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا' } } ) } ) );
		render( <WishlistTab /> );

		expect( await screen.findByText( 'خطا در دریافت علاقه‌مندی‌ها.' ) ).toBeTruthy();
	} );

	it( 'removing an item calls the real DELETE endpoint and optimistically removes it from the list', async () => {
		mockFetch();
		render( <WishlistTab /> );

		await screen.findByText( 'سالن آرایش الف' );
		fireEvent.click( screen.getAllByLabelText( 'حذف از علاقه‌مندی‌ها' )[ 0 ] );

		await waitFor( () => expect( screen.queryByText( 'سالن آرایش الف' ) ).toBeNull() );
		expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls.some( ( c ) => String( c[ 0 ] ).includes( '/marketplace/wishlist/1' ) && c[ 1 ]?.method === 'DELETE' ) ).toBe( true );
	} );
} );
