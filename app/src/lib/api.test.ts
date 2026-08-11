import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe( 'api URL building', () => {
	beforeEach( () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: true,
			json: () => Promise.resolve( { data: {}, meta: {}, error: null } ),
		} ) );
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
		window.BeauClick = undefined;
	} );

	it( 'merges query params into rest_route under plain permalinks instead of producing a second "?"', async () => {
		window.BeauClick = { restUrl: 'http://localhost:8080/?rest_route=/beauclick/v1', nonce: 'x', isLoggedIn: true, currentUserId: 1, checkoutUrl: null, cartUrl: null };
		const { api } = await import( './api' );

		await api.get( '/booking/availability?provider_id=11&date=2026-08-11' );

		const calledUrl = ( fetch as unknown as ReturnType<typeof vi.fn> ).mock.calls[ 0 ][ 0 ] as string;
		const parsed = new URL( calledUrl );

		expect( parsed.searchParams.get( 'rest_route' ) ).toBe( '/beauclick/v1/booking/availability' );
		expect( parsed.searchParams.get( 'provider_id' ) ).toBe( '11' );
		expect( parsed.searchParams.get( 'date' ) ).toBe( '2026-08-11' );
		// Must never contain two literal "?" characters.
		expect( calledUrl.indexOf( '?' ) ).toBe( calledUrl.lastIndexOf( '?' ) );
	} );

	it( 'appends cleanly to a plain path under pretty permalinks', async () => {
		window.BeauClick = { restUrl: '/wp-json/beauclick/v1', nonce: 'x', isLoggedIn: true, currentUserId: 1, checkoutUrl: null, cartUrl: null };
		const { api } = await import( './api' );

		await api.get( '/marketplace/providers?city_id=4' );

		const calledUrl = ( fetch as unknown as ReturnType<typeof vi.fn> ).mock.calls[ 0 ][ 0 ] as string;
		const parsed = new URL( calledUrl );

		expect( parsed.pathname ).toBe( '/wp-json/beauclick/v1/marketplace/providers' );
		expect( parsed.searchParams.get( 'city_id' ) ).toBe( '4' );
	} );
} );
