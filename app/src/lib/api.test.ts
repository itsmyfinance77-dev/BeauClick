import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';

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

describe( 'api error message localization', () => {
	beforeEach( () => {
		window.BeauClick = { restUrl: '/wp-json/beauclick/v1', nonce: 'x', isLoggedIn: true, currentUserId: 1, checkoutUrl: null, cartUrl: null };
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
		window.BeauClick = undefined;
	} );

	it( 'surfaces the real Persian message from the app\'s own {data,meta,error} envelope', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: false,
			status: 404,
			json: () => Promise.resolve( { data: null, meta: {}, error: { code: 'bc_not_found', message: 'این پروفایل پیدا نشد.' } } ),
		} ) );
		const { api } = await import( './api' );

		await expect( api.get( '/marketplace/providers/999' ) ).rejects.toMatchObject( { code: 'bc_not_found', message: 'این پروفایل پیدا نشد.' } );
	} );

	it( 'surfaces the real Persian message from WordPress core\'s native {code,message,data} shape (a rejected permission_callback)', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: false,
			status: 401,
			json: () => Promise.resolve( { code: 'bc_unauthorized', message: 'برای ادامه، ابتدا وارد حساب کاربری خود شوید.', data: { status: 401 } } ),
		} ) );
		const { api } = await import( './api' );

		await expect( api.get( '/journey/summary' ) ).rejects.toMatchObject( { code: 'bc_unauthorized', message: 'برای ادامه، ابتدا وارد حساب کاربری خود شوید.' } );
	} );

	it( 'never surfaces a raw English HTTP reason phrase when no structured error body exists', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			json: () => Promise.reject( new Error( 'not JSON' ) ),
		} ) );
		const { api } = await import( './api' );

		try {
			await api.get( '/booking/bookings' );
			expect.fail( 'expected api.get to throw' );
		} catch ( e ) {
			expect( e ).toBeInstanceOf( ApiError );
			expect( ( e as ApiError ).message ).not.toMatch( /[a-zA-Z]/ );
		}
	} );

	it( 'degrades a real network failure to the same generic Persian message, never a raw browser error', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockRejectedValue( new TypeError( 'Failed to fetch' ) ) );
		const { api } = await import( './api' );

		try {
			await api.get( '/booking/bookings' );
			expect.fail( 'expected api.get to throw' );
		} catch ( e ) {
			expect( e ).toBeInstanceOf( ApiError );
			expect( ( e as ApiError ).message ).not.toMatch( /[a-zA-Z]/ );
		}
	} );
} );
