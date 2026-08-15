import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeaderSearch } from './HeaderSearch';

const SPECIALTIES = [
	{ id: 16, name: 'میکاپ' },
	{ id: 19, name: 'رنگ مو' },
];
const CITIES = [
	{ id: 3, name_fa: 'یزد', is_launched: true },
	{ id: 4, name_fa: 'تهران', is_launched: true },
];

function mockReferenceDataFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn( ( input: RequestInfo | URL ) => {
			const url = String( input );
			const data = url.includes( '/marketplace/specialties' ) ? SPECIALTIES : CITIES;
			return Promise.resolve( { ok: true, json: async () => ( { data, meta: {}, error: null } ) } as Response );
		} )
	);
}

function mockFailedFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue( {
			ok: false,
			json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا در دریافت اطلاعات جستجو.' } } ),
		} )
	);
}

function typeQuery( text: string ) {
	fireEvent.change( screen.getByLabelText( 'جستجوی تخصص یا شهر' ), { target: { value: text } } );
}

function submitForm() {
	fireEvent.submit( screen.getByRole( 'search' ) );
}

describe( 'HeaderSearch', () => {
	let originalLocation: Location;

	beforeEach( () => {
		originalLocation = window.location;
		// jsdom throws "Not implemented: navigation" on a real assignment to
		// window.location.href — replace it with a plain writable object so
		// the component's real `window.location.href = url` line can be
		// asserted against directly, matching how a real navigation would
		// behave without actually navigating inside the test environment.
		// @ts-expect-error -- intentionally replacing the read-only global for this test only.
		delete window.location;
		// @ts-expect-error -- see above.
		window.location = { href: '', origin: originalLocation.origin };
	} );

	afterEach( () => {
		vi.unstubAllGlobals();
		// @ts-expect-error -- restoring the real Location object replaced in beforeEach.
		window.location = originalLocation;
	} );

	// 1/2. The button is wired and the overlay opens with real data, not a dead click.
	it( 'renders real specialty chips fetched from the marketplace reference endpoint when open', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		expect( await screen.findByText( 'میکاپ' ) ).toBeTruthy();
		expect( screen.getByText( 'رنگ مو' ) ).toBeTruthy();
	} );

	it( 'renders nothing (no fetch, no DOM) while closed', () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ false } onClose={ () => {} } /> );

		expect( screen.queryByText( 'جستجو در بیوکلیک' ) ).toBeNull();
	} );

	// 3/4. Typing a real Persian query filters the already-fetched real lists and selecting one navigates for real.
	it( 'typing a matching Persian query filters to the real specialty and selecting it navigates to the real marketplace URL', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		typeQuery( 'میکاپ' );

		expect( screen.queryByText( 'رنگ مو' ) ).toBeNull(); // filtered out, not just hidden

		fireEvent.click( screen.getByText( 'میکاپ' ) );

		expect( window.location.href ).toContain( '/marketplace/' );
		expect( window.location.href ).toContain( 'specialty_id=16' );
	} );

	it( 'selecting a matching city navigates with city_id, never specialty_id', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		typeQuery( 'یزد' );
		fireEvent.click( await screen.findByText( 'یزد' ) );

		expect( window.location.href ).toContain( 'city_id=3' );
		expect( window.location.href ).not.toContain( 'specialty_id' );
	} );

	// 5. Empty submit falls back to the real, existing, unfiltered marketplace listing -- never nothing, never a fabricated destination.
	it( 'submitting an empty query navigates to the plain marketplace listing', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		submitForm();

		expect( window.location.href ).toBe( `${ originalLocation.origin }/marketplace/` );
	} );

	// 6. No chip match is honest -- no fabricated specialty/city, but a real free-text search (V2.3 Step 20) is offered instead of a dead end.
	it( 'shows a Persian no-chip-match state for a query matching neither specialties nor cities, offering a real text-search fallback', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		typeQuery( 'zzz_no_such_thing' );

		expect( await screen.findByText( 'تخصص یا شهری با این نام پیدا نشد.' ) ).toBeTruthy();
		expect( screen.getByText( 'مشاهده همه متخصصان' ) ).toBeTruthy();

		fireEvent.click( screen.getByText( 'جستجوی «zzz_no_such_thing» در بین متخصصان' ) );
		expect( window.location.href ).toContain( '/marketplace/' );
		expect( window.location.href ).toContain( 'q=zzz_no_such_thing' );
	} );

	// V2.3 Step 20: submitting (not just clicking the fallback button) a no-chip-match query goes to the real q= search too.
	it( 'submitting a query matching no specialty/city chip navigates to a real free-text marketplace search', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		typeQuery( 'کاشت ناخن' );
		submitForm();

		const url = new URL( window.location.href );
		expect( url.pathname ).toBe( '/marketplace/' );
		expect( url.searchParams.get( 'q' ) ).toBe( 'کاشت ناخن' );
	} );

	// 7. A real backend failure surfaces a real Persian error, never a silent blank panel.
	it( 'shows a Persian error message when the reference-data request fails', async () => {
		mockFailedFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		expect( await screen.findByText( 'خطا در دریافت اطلاعات جستجو.' ) ).toBeTruthy();
	} );

	// Accessible label + real dialog semantics (Modal already provides focus trap/Escape -- see Modal.a11y.test.tsx).
	it( 'exposes a real accessible label on the search input and a labelled dialog', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		expect( screen.getByRole( 'dialog', { name: 'جستجو در بیوکلیک' } ) ).toBeTruthy();
		expect( screen.getByLabelText( 'جستجوی تخصص یا شهر' ) ).toBeTruthy();
	} );

	it( 'an ambiguous query matching both a specialty and a city never guesses a destination on submit', async () => {
		mockReferenceDataFetch();
		render( <HeaderSearch open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'میکاپ' );
		// 'ی' matches exactly one specialty (میکاپ) AND exactly one city
		// (یزد) in the fixture data above -- neither list is uniquely
		// resolvable on its own, so submitting must never guess.
		typeQuery( 'ی' );
		expect( await screen.findByText( 'یزد' ) ).toBeTruthy();
		expect( screen.getByText( 'میکاپ' ) ).toBeTruthy();

		submitForm();
		expect( window.location.href ).toBe( '' ); // no navigation happened -- ambiguous, left to explicit selection
	} );
} );
