import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AnalyticsTab } from './AnalyticsTab';

function mockFetchOnce( data: unknown ) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue( {
			ok: true,
			json: async () => ( { data, meta: {}, error: null } ),
		} )
	);
}

const SAMPLE_SUMMARY = {
	range: { from: '2026-08-01', to: '2026-08-14' },
	providerId: 7,
	postType: 'bc_professional',
	metrics: {
		funnel: { started: 12, confirmed: 10, completed: 8, cancelled: 1, expired: 1, noShow: 0, rescheduled: 2, conversionRate: 0.6667 },
		profileViews: 45,
		reviews: { count: 5, avgRating: 4.6 },
		customers: { total: 9, repeat: 3, newInRange: 4 },
		servicePerformance: [ { serviceId: 1, serviceName: 'میکاپ عروس', completedCount: 5 } ],
	},
	benchmark: { peerCount: 3, scope: 'specialty_peers', conversionRate: 0.5, avgRating: 4.2 },
	b2b: null,
};

describe( 'AnalyticsTab', () => {
	afterEach( () => {
		vi.unstubAllGlobals();
	} );

	it( 'renders real scoped metrics from /analytics/my/summary, not placeholder data', async () => {
		mockFetchOnce( SAMPLE_SUMMARY );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( '۴۵' ) ).toBeTruthy(); // profile views
		expect( screen.getByText( '۸' ) ).toBeTruthy(); // completed bookings
	} );

	it( 'shows the top service by completed bookings', async () => {
		mockFetchOnce( SAMPLE_SUMMARY );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( 'میکاپ عروس' ) ).toBeTruthy();
	} );

	it( 'does not render a B2B section when the professional has no B2B account', async () => {
		mockFetchOnce( SAMPLE_SUMMARY );
		render( <AnalyticsTab /> );

		await waitFor( () => screen.getByText( '۴۵' ) );
		expect( screen.queryByText( 'فعالیت B2B' ) ).toBeNull();
	} );

	it( 'renders a B2B section when the summary includes one', async () => {
		mockFetchOnce( { ...SAMPLE_SUMMARY, b2b: { accountStatus: 'approved', quoteCounts: { requested: 2, quoted: 1, accepted: 1, expired: 0 }, grossOrderValueLabel: 'ارزش ناخالص سفارش‌های تأییدشده', grossOrderValue: 500000 } } );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( 'فعالیت B2B' ) ).toBeTruthy();
	} );

	it( 'renders the specialty-peer benchmark with a real peer count, never a generic platform-wide label when peers were actually found', async () => {
		mockFetchOnce( SAMPLE_SUMMARY );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( 'مقایسه با هم‌رده‌ها' ) ).toBeTruthy();
		expect( screen.getByText( 'میانگین ۳ متخصص دیگر با تخصص مشابه شما' ) ).toBeTruthy();
	} );

	it( 'labels a platform_wide benchmark honestly, never presenting it as a specialty match', async () => {
		mockFetchOnce( { ...SAMPLE_SUMMARY, benchmark: { peerCount: 20, scope: 'platform_wide', conversionRate: 0.4, avgRating: 4.0 } } );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( 'میانگین ۲۰ متخصص دیگر در پلتفرم (تخصصی برای شما ثبت نشده است)' ) ).toBeTruthy();
	} );

	it( 'shows a real empty state, not a fabricated zero, when there are genuinely no peers to compare against', async () => {
		mockFetchOnce( { ...SAMPLE_SUMMARY, benchmark: { peerCount: 0, scope: 'specialty_peers', conversionRate: 0, avgRating: 0 } } );
		render( <AnalyticsTab /> );

		expect( await screen.findByText( 'در حال حاضر هم‌ردهٔ کافی برای مقایسه یافت نشد.' ) ).toBeTruthy();
	} );
} );
