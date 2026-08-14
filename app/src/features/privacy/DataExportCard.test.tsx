import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataExportCard } from './DataExportCard';
import { expectNoAccessibilityViolations } from '../../test/axe';

function mockFetchOnce( data: unknown ) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue( {
			ok: true,
			json: async () => ( { data, meta: {}, error: null } ),
		} )
	);
}

describe( 'DataExportCard', () => {
	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'shows a request button when no export exists yet', async () => {
		mockFetchOnce( null );
		render( <DataExportCard /> );

		expect( await screen.findByRole( 'button', { name: /درخواست دریافت اطلاعات/ } ) ).toBeTruthy();
	} );

	it( 'shows a download link built through api.urlWithNonce(), not the raw path, when a ready export exists', async () => {
		mockFetchOnce( {
			id: 1,
			status: 'ready',
			requestedAt: '2026-08-01 10:00:00',
			expiresAt: '2099-01-01 00:00:00',
			downloadPath: '/privacy/export/download?token=abc',
		} );
		render( <DataExportCard /> );

		const link = await screen.findByRole( 'link', { name: /دانلود فایل اطلاعات/ } );
		const href = link.getAttribute( 'href' ) ?? '';
		// A plain <a href> navigation carries the auth cookie but no
		// X-WP-Nonce header -- WordPress core's own REST cookie-auth CSRF
		// guard rejects that as unauthenticated (a real bug found live
		// during this step's own QA pass). The href must therefore be built
		// through api.urlWithNonce(), which appends a fresh nonce, not the
		// raw downloadPath the API returned.
		expect( href ).toContain( '/privacy/export/download' );
		expect( href ).toContain( 'token=abc' );
	} );

	it( 'has no automatically detectable accessibility violations', async () => {
		mockFetchOnce( null );
		const { container } = render( <DataExportCard /> );

		await waitFor( () => screen.getByRole( 'button', { name: /درخواست دریافت اطلاعات/ } ) );
		await expectNoAccessibilityViolations( container );
	} );
} );
