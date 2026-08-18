import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationBell } from './NotificationBell';

const ITEMS = [
	{ id: 1, category: 'reminder', templateKey: 'booking_reminder', channel: 'sms', status: 'sent', createdAt: '2026-08-19 10:00:00', isRead: false },
	{ id: 2, category: 'waitlist', templateKey: 'waitlist_opened', channel: 'sms', status: 'sent', createdAt: '2026-08-18 10:00:00', isRead: true },
];

function mockFetch( items = ITEMS ) {
	vi.stubGlobal(
		'fetch',
		vi.fn( ( input: RequestInfo | URL ) => {
			const url = String( input );
			if ( url.includes( '/notifications/mine' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: items, meta: {}, error: null } ) } as Response );
			}
			if ( url.includes( '/read' ) || url.includes( '/mark-all-read' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: { marked: true }, meta: {}, error: null } ) } as Response );
			}
			if ( url.includes( '/unread-count' ) ) {
				return Promise.resolve( { ok: true, json: async () => ( { data: { count: 0 }, meta: {}, error: null } ) } as Response );
			}
			return Promise.resolve( { ok: false, json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا' } } ) } as Response );
		} )
	);
}

function mockFailedFetch() {
	vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( { ok: false, json: async () => ( { data: null, meta: {}, error: { code: 'bc_error', message: 'خطا در دریافت اعلان‌ها.' } } ) } ) );
}

describe( 'NotificationBell', () => {
	afterEach( () => vi.unstubAllGlobals() );

	it( 'renders nothing (no fetch) while closed', () => {
		mockFetch();
		render( <NotificationBell open={ false } onClose={ () => {} } /> );
		expect( screen.queryByText( 'اعلان‌ها' ) ).toBeNull();
	} );

	it( 'fetches and renders the real notification list when opened, with an unread indicator only on the unread item', async () => {
		mockFetch();
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		expect( await screen.findByText( 'یادآوری نوبت' ) ).toBeTruthy();
		expect( screen.getByText( 'لیست انتظار' ) ).toBeTruthy();
	} );

	it( 'shows an empty state for a real empty list, not a blank panel', async () => {
		mockFetch( [] );
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		expect( await screen.findByText( 'اعلانی برای شما ثبت نشده است.' ) ).toBeTruthy();
	} );

	it( 'shows a Persian error message when fetching fails, never a silent blank panel', async () => {
		mockFailedFetch();
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		expect( await screen.findByText( 'خطا در دریافت اعلان‌ها.' ) ).toBeTruthy();
	} );

	it( 'clicking an unread notification marks it read in the UI and calls the real REST endpoint', async () => {
		mockFetch();
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'یادآوری نوبت' );
		fireEvent.click( screen.getByText( 'یادآوری نوبت' ) );

		await waitFor( () => {
			expect( ( fetch as ReturnType<typeof vi.fn> ).mock.calls.some( ( c: unknown[] ) => String( c[ 0 ] ).includes( '/notifications/1/read' ) ) ).toBe( true );
		} );
	} );

	it( '"mark all as read" only appears when there is a real unread item, and disappears once none remain', async () => {
		mockFetch();
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'یادآوری نوبت' );
		expect( screen.getByText( 'علامت‌گذاری همه به‌عنوان خوانده‌شده' ) ).toBeTruthy();

		fireEvent.click( screen.getByText( 'علامت‌گذاری همه به‌عنوان خوانده‌شده' ) );

		await waitFor( () => {
			expect( screen.queryByText( 'علامت‌گذاری همه به‌عنوان خوانده‌شده' ) ).toBeNull();
		} );
	} );

	it( 'never shows the mark-all-read action when every real item is already read', async () => {
		mockFetch( [ ITEMS[ 1 ] ] ); // only the already-read item
		render( <NotificationBell open={ true } onClose={ () => {} } /> );

		await screen.findByText( 'لیست انتظار' );
		expect( screen.queryByText( 'علامت‌گذاری همه به‌عنوان خوانده‌شده' ) ).toBeNull();
	} );
} );
