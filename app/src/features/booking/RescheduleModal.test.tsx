import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RescheduleModal } from './RescheduleModal';

function mockFetchSequence( responses: Array<{ match: RegExp; data: unknown }> ) {
	vi.stubGlobal(
		'fetch',
		vi.fn( ( url: string ) => {
			const found = responses.find( ( r ) => r.match.test( url ) );
			return Promise.resolve( {
				ok: true,
				json: async () => ( { data: found ? found.data : null, meta: {}, error: null } ),
			} );
		} )
	);
}

const booking = { id: 42, providerId: 7, slotStart: '2026-09-01 10:00:00' };

describe( 'RescheduleModal', () => {
	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'shows the ineligible reason instead of a slot picker when the booking cannot be rescheduled', async () => {
		mockFetchSequence( [
			{ match: /reschedule-eligibility/, data: { eligible: false, reason: 'max_reached', rescheduleCount: 2, maxReschedules: 2, minHoursBefore: 6 } },
		] );

		render( <RescheduleModal open booking={ booking } onClose={ () => {} } onRescheduled={ () => {} } /> );

		expect( await screen.findByText( /حداکثر تعداد مجاز جابه‌جایی/ ) ).toBeTruthy();
		expect( screen.queryByRole( 'button', { name: /تأیید جابه‌جایی/ } ) ).toBeNull();
	} );

	it( 'lets an eligible customer pick a new slot and confirm the reschedule', async () => {
		mockFetchSequence( [
			{ match: /reschedule-eligibility/, data: { eligible: true, reason: null, rescheduleCount: 0, maxReschedules: 2, minHoursBefore: 6 } },
			{ match: /booking\/availability/, data: [ { id: 99, serviceId: null, startAt: '2026-09-05 12:00:00', endAt: '2026-09-05 13:00:00' } ] },
			{ match: /reschedule$/, data: { id: 42, slotId: 99, status: 'confirmed' } },
		] );

		const onRescheduled = vi.fn();
		render( <RescheduleModal open booking={ booking } onClose={ () => {} } onRescheduled={ onRescheduled } /> );

		const slotChip = await screen.findByText( '۱۲:۰۰' );
		fireEvent.click( slotChip );

		const confirmButton = await screen.findByRole( 'button', { name: /تأیید جابه‌جایی/ } );
		expect( confirmButton.hasAttribute( 'disabled' ) ).toBe( false );

		fireEvent.click( confirmButton );

		await waitFor( () => expect( onRescheduled ).toHaveBeenCalled() );
	} );
} );
