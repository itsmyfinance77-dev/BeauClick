import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileTab } from './ProfileTab';

const PROFILE = { id: 1, name: 'سارا احمدی', bio: 'متخصص ناخن', status: 'publish', cityId: null, districtId: null, verified: true, specialtyIds: [ 10 ] };
const SPECIALTIES = [ { id: 10, name: 'کاشت ناخن' }, { id: 11, name: 'میکاپ' } ];
const PORTFOLIO = [ { id: 1, title: 'عروسی بهار', image: 'https://example.test/img.jpg' } ];

function mockFetch( overrides: Partial<{ patchOk: boolean; uploadOk: boolean; deleteOk: boolean }> = {} ) {
	const { patchOk = true, uploadOk = true, deleteOk = true } = overrides;
	vi.stubGlobal(
		'fetch',
		vi.fn( ( input: RequestInfo | URL, init?: RequestInit ) => {
			const url = String( input );
			if ( init?.method === 'PATCH' ) {
				return Promise.resolve( { ok: patchOk, json: async () => ( { data: { updated: patchOk }, meta: {}, error: patchOk ? null : { code: 'bc_error', message: 'خطا' } } ) } as Response );
			}
			if ( init?.method === 'DELETE' ) {
				return Promise.resolve( { ok: deleteOk, json: async () => ( { data: { deleted: deleteOk }, meta: {}, error: null } ) } as Response );
			}
			if ( init?.method === 'POST' && url.includes( '/marketplace/my/portfolio' ) ) {
				return Promise.resolve( { ok: uploadOk, json: async () => ( { data: uploadOk ? { id: 2, title: 'جدید', image: 'https://example.test/new.jpg' } : null, meta: {}, error: uploadOk ? null : { code: 'bc_upload_failed', message: 'بارگذاری ناموفق بود.' } } ) } as Response );
			}
			if ( url.includes( '/marketplace/my/profile' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: PROFILE, meta: {}, error: null } ) } as Response );
			}
			if ( url.includes( '/marketplace/specialties' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: SPECIALTIES, meta: {}, error: null } ) } as Response );
			}
			if ( url.includes( '/marketplace/my/portfolio' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: PORTFOLIO, meta: {}, error: null } ) } as Response );
			}
			return Promise.resolve( { ok: false, json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا' } } ) } as Response );
		} )
	);
}

describe( 'ProfileTab', () => {
	afterEach( () => vi.unstubAllGlobals() );

	it( 'fetches and renders the real profile, specialties, and portfolio', async () => {
		mockFetch();
		render( <ProfileTab /> );

		expect( await screen.findByDisplayValue( 'سارا احمدی' ) ).toBeTruthy();
		expect( screen.getByDisplayValue( 'متخصص ناخن' ) ).toBeTruthy();
		expect( screen.getByText( 'کاشت ناخن' ).getAttribute( 'aria-pressed' ) ).toBe( 'true' );
		expect( screen.getByText( 'میکاپ' ).getAttribute( 'aria-pressed' ) ).toBe( 'false' );
		expect( await screen.findByText( 'عروسی بهار' ) ).toBeTruthy();
	} );

	it( 'toggling a specialty chip updates its own pressed state', async () => {
		mockFetch();
		render( <ProfileTab /> );

		await screen.findByDisplayValue( 'سارا احمدی' );
		fireEvent.click( screen.getByText( 'میکاپ' ) );

		expect( screen.getByText( 'میکاپ' ).getAttribute( 'aria-pressed' ) ).toBe( 'true' );
	} );

	it( 'saving calls the real PATCH endpoint with the edited fields and shows a success message', async () => {
		mockFetch();
		render( <ProfileTab /> );

		await screen.findByDisplayValue( 'سارا احمدی' );
		fireEvent.change( screen.getByDisplayValue( 'سارا احمدی' ), { target: { value: 'سارا احمدی راد' } } );
		fireEvent.click( screen.getByText( 'ذخیره تغییرات' ) );

		await screen.findByText( 'پروفایل ذخیره شد.' );
		const patchCall = ( fetch as ReturnType<typeof vi.fn> ).mock.calls.find( ( c ) => c[ 1 ]?.method === 'PATCH' );
		expect( patchCall ).toBeTruthy();
		expect( JSON.parse( patchCall![ 1 ].body ) ).toMatchObject( { name: 'سارا احمدی راد' } );
	} );

	it( 'shows a Persian error message when saving fails', async () => {
		mockFetch( { patchOk: false } );
		render( <ProfileTab /> );

		await screen.findByDisplayValue( 'سارا احمدی' );
		fireEvent.click( screen.getByText( 'ذخیره تغییرات' ) );

		expect( await screen.findByText( 'خطا' ) ).toBeTruthy();
	} );

	it( 'removing a portfolio item optimistically removes it and calls the real DELETE endpoint', async () => {
		mockFetch();
		render( <ProfileTab /> );

		await screen.findByText( 'عروسی بهار' );
		fireEvent.click( screen.getByLabelText( 'حذف عروسی بهار' ) );

		await waitFor( () => expect( screen.queryByText( 'عروسی بهار' ) ).toBeNull() );
		expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls.some( ( c ) => String( c[ 0 ] ).includes( '/marketplace/my/portfolio/1' ) && c[ 1 ]?.method === 'DELETE' ) ).toBe( true );
	} );

	it( 'shows an empty state when no portfolio items exist yet', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn( ( input: RequestInfo | URL ) => {
				const url = String( input );
				if ( url.includes( '/marketplace/my/profile' ) ) return Promise.resolve( { ok: true, json: async () => ( { data: PROFILE, meta: {}, error: null } ) } as Response );
				if ( url.includes( '/marketplace/specialties' ) ) return Promise.resolve( { ok: true, json: async () => ( { data: SPECIALTIES, meta: {}, error: null } ) } as Response );
				if ( url.includes( '/marketplace/my/portfolio' ) ) return Promise.resolve( { ok: true, json: async () => ( { data: [], meta: {}, error: null } ) } as Response );
				return Promise.resolve( { ok: false, json: async () => ( { data: null, meta: {}, error: null } ) } as Response );
			} )
		);
		render( <ProfileTab /> );

		expect( await screen.findByText( 'هنوز نمونه‌کاری اضافه نکرده‌اید.' ) ).toBeTruthy();
	} );
} );
