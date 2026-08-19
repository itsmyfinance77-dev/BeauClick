import { afterEach, describe, expect, it, vi } from 'vitest';
import './wishlist-button';

function mockFetch( ok = true ) {
	vi.stubGlobal(
		'fetch',
		vi.fn( () => Promise.resolve( { ok, json: async () => ( { data: { wishlisted: true }, meta: {}, error: null } ) } as Response ) )
	);
}

function renderButton( wishlisted: boolean ): HTMLButtonElement {
	document.body.innerHTML = `
		<button type="button" data-bc-wishlist-toggle data-provider-id="42" data-wishlisted="${ wishlisted }" aria-pressed="${ wishlisted }">
			<span aria-hidden="true">${ wishlisted ? '♥' : '♡' }</span>
			<span data-bc-wishlist-label>${ wishlisted ? 'در علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی‌ها' }</span>
		</button>
	`;
	return document.querySelector( 'button' ) as HTMLButtonElement;
}

describe( 'wishlist-button mount', () => {
	afterEach( () => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	} );

	it( 'optimistically marks the button as wishlisted on click and calls the real POST endpoint', () => {
		mockFetch();
		const button = renderButton( false );

		button.click();

		expect( button.dataset.wishlisted ).toBe( 'true' );
		expect( button.getAttribute( 'aria-pressed' ) ).toBe( 'true' );
		expect( button.querySelector( '[data-bc-wishlist-label]' )?.textContent ).toBe( 'در علاقه‌مندی‌ها' );
		expect( button.querySelector( '[aria-hidden="true"]' )?.textContent ).toBe( '♥' );
		expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls[ 0 ][ 0 ] ).toContain( '/marketplace/wishlist/42' );
		expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls[ 0 ][ 1 ].method ).toBe( 'POST' );
	} );

	it( 'calls the real DELETE endpoint when removing an already-wishlisted provider', () => {
		mockFetch();
		const button = renderButton( true );

		button.click();

		expect( button.dataset.wishlisted ).toBe( 'false' );
		expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls[ 0 ][ 1 ].method ).toBe( 'DELETE' );
	} );

	it( 'reverts the optimistic state if the real request fails, never leaving a false-positive UI', async () => {
		mockFetch( false );
		const button = renderButton( false );

		button.click();
		expect( button.dataset.wishlisted ).toBe( 'true' ); // optimistic

		await new Promise( ( r ) => setTimeout( r, 0 ) );
		expect( button.dataset.wishlisted ).toBe( 'false' ); // reverted
	} );

	it( 'ignores clicks on unrelated elements', () => {
		mockFetch();
		document.body.innerHTML = '<button type="button">unrelated</button>';
		( document.querySelector( 'button' ) as HTMLButtonElement ).click();

		expect( fetch ).not.toHaveBeenCalled();
	} );
} );
