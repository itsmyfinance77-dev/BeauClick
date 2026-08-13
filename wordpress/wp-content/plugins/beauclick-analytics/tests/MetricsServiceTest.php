<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tests;

use BeauClick\Analytics\Metrics\MetricsService;
use WP_UnitTestCase;

final class MetricsServiceTest extends WP_UnitTestCase {

	private function log( string $event_type, string $entity_type, int $entity_id, ?int $actor_id = null, array $meta = [] ): void {
		beauclick_core()->events()->log( $event_type, $entity_type, $entity_id, $actor_id, $meta );
	}

	private function today(): string {
		return current_time( 'Y-m-d' );
	}

	// 1. range normalization defaults.
	public function test_normalize_range_defaults_to_last_30_days_when_both_missing(): void {
		[ $from, $to ] = MetricsService::normalize_range( null, null );

		$this->assertSame( current_time( 'Y-m-d' ), $to );
		$this->assertSame( gmdate( 'Y-m-d', strtotime( $to . ' -29 days' ) ), $from );
	}

	// 2. reversed range is swapped, not left broken.
	public function test_normalize_range_swaps_a_reversed_range(): void {
		[ $from, $to ] = MetricsService::normalize_range( '2026-08-20', '2026-08-01' );

		$this->assertSame( '2026-08-01', $from );
		$this->assertSame( '2026-08-20', $to );
	}

	// 3. a query must never turn into an unbounded scan.
	public function test_normalize_range_clamps_an_absurdly_wide_window(): void {
		[ $from, $to ] = MetricsService::normalize_range( '2000-01-01', '2026-01-01' );

		$days = ( strtotime( $to ) - strtotime( $from ) ) / DAY_IN_SECONDS;
		$this->assertLessThanOrEqual( 366, $days );
		$this->assertSame( '2026-01-01', $to );
	}

	// 4. booking funnel conversion rate is completed/started, from real events.
	public function test_funnel_conversion_rate_reflects_real_events(): void {
		$this->log( 'booking_created', 'booking', 1 );
		$this->log( 'booking_created', 'booking', 2 );
		$this->log( 'booking_confirmed', 'booking', 1 );
		$this->log( 'booking_completed', 'booking', 1 );

		$funnel = ( new MetricsService() )->funnel( $this->today(), $this->today() );

		$this->assertSame( 2, $funnel['started'] );
		$this->assertSame( 1, $funnel['confirmed'] );
		$this->assertSame( 1, $funnel['completed'] );
		$this->assertSame( 0.5, $funnel['conversionRate'] );
	}

	// 5. conversion rate must not divide by zero when nothing happened in range.
	public function test_funnel_conversion_rate_is_zero_with_no_events(): void {
		$funnel = ( new MetricsService() )->funnel( '2020-01-01', '2020-01-01' );

		$this->assertSame( 0, $funnel['started'] );
		$this->assertSame( 0.0, $funnel['conversionRate'] );
	}

	// 6. commerce() must exclude order_completed events whose order is a
	// booking order (linked via wp_bc_bookings.wc_order_id), so the shop
	// funnel isn't distorted by orders that never went through
	// checkout_started in the first place (COM-05 / this step's own
	// double-counting caution).
	public function test_commerce_excludes_booking_linked_orders_but_overview_counts_everything(): void {
		global $wpdb;

		$booking_order_id = 9001;
		$shop_order_id     = 9002;

		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id'  => 1,
				'provider_id'  => 1,
				'service_id'   => 1,
				'slot_id'      => 1,
				'slot_start'   => current_time( 'mysql' ),
				'slot_end'     => current_time( 'mysql' ),
				'status'       => 'confirmed',
				'wc_order_id'  => $booking_order_id,
				'payment_status' => 'paid',
				'created_at'   => current_time( 'mysql' ),
				'updated_at'   => current_time( 'mysql' ),
				'expires_at'   => current_time( 'mysql' ),
			]
		);

		$this->log( 'order_completed', 'order', $booking_order_id, null, [ 'total' => 500000 ] );
		$this->log( 'order_completed', 'order', $shop_order_id, null, [ 'total' => 300000 ] );
		$this->log( 'checkout_started', 'cart', 0 );

		$service  = new MetricsService();
		$commerce = $service->commerce( $this->today(), $this->today() );
		$overview = $service->overview( $this->today(), $this->today() );

		$this->assertSame( 1, $commerce['ordersCompleted'], 'commerce() must only count the non-booking order' );
		$this->assertSame( 2, $overview['ordersCompletedAllTypes'], 'overview() counts both booking and shop orders' );
		$this->assertSame( 800000.0, $overview['grossRevenueAllTypes'] );
	}

	// 7. search zero-result detection reads the JSON meta correctly.
	public function test_search_reports_zero_result_rate_from_event_meta(): void {
		$this->log( 'search_performed', 'search', 0, null, [ 'resultCount' => 0, 'specialtyFilter' => true, 'locationFilter' => false ] );
		$this->log( 'search_performed', 'search', 0, null, [ 'resultCount' => 5, 'specialtyFilter' => false, 'locationFilter' => true ] );

		$search = ( new MetricsService() )->search( $this->today(), $this->today() );

		$this->assertSame( 2, $search['totalSearches'] );
		$this->assertSame( 1, $search['zeroResultSearches'] );
		$this->assertSame( 0.5, $search['zeroResultRate'] );
		$this->assertSame( 1, $search['specialtyFilterUsage'] );
		$this->assertSame( 1, $search['locationFilterUsage'] );
	}

	// 8. AI click-through rate.
	public function test_ai_click_through_rate(): void {
		$this->log( 'ai_recommendation_shown', 'professional', 1 );
		$this->log( 'ai_recommendation_shown', 'professional', 2 );
		$this->log( 'ai_recommendation_clicked', 'professional', 1 );

		$ai = ( new MetricsService() )->ai( $this->today(), $this->today() );

		$this->assertSame( 2, $ai['recommendationsShown'] );
		$this->assertSame( 1, $ai['recommendationsClicked'] );
		$this->assertSame( 0.5, $ai['clickThroughRate'] );
	}

	// 9. usage() reads the new UI-visibility ping events only.
	public function test_usage_counts_crm_and_journey_opened(): void {
		$this->log( 'crm_opened', 'ui', 0, 42 );
		$this->log( 'journey_opened', 'ui', 0, 42 );
		$this->log( 'journey_opened', 'ui', 0, 43 );

		$usage = ( new MetricsService() )->usage( $this->today(), $this->today() );

		$this->assertSame( 1, $usage['crmOpened'] );
		$this->assertSame( 2, $usage['journeyOpened'] );
	}

	// 10. referral() reads real referral-domain events + the loyalty
	// ledger's referral-specific reasons (V2.2 Step 12), reusing this same
	// live-aggregation architecture rather than a second analytics engine.
	public function test_referral_reports_counts_and_qualification_rate(): void {
		global $wpdb;

		$this->log( 'referral_link_shared', 'ui', 0, 1 );
		$this->log( 'referral_signup_attributed', 'referral', 1, 2 );
		$this->log( 'referral_signup_attributed', 'referral', 2, 3 );
		$this->log( 'referral_qualified', 'referral', 1, 2 );
		$this->log( 'referral_rewarded', 'referral', 1, null );

		$wpdb->insert(
			$wpdb->prefix . 'bc_loyalty_points',
			[ 'user_id' => 1, 'points' => 50, 'reason' => 'referral_referrer_reward', 'reference_type' => 'referral', 'reference_id' => 1, 'created_at' => current_time( 'mysql' ) ]
		);
		$wpdb->insert(
			$wpdb->prefix . 'bc_loyalty_points',
			[ 'user_id' => 2, 'points' => 50, 'reason' => 'referral_referee_reward', 'reference_type' => 'referral', 'reference_id' => 1, 'created_at' => current_time( 'mysql' ) ]
		);

		$referral = ( new MetricsService() )->referral( $this->today(), $this->today() );

		$this->assertSame( 1, $referral['linkShared'] );
		$this->assertSame( 2, $referral['signupsAttributed'] );
		$this->assertSame( 1, $referral['qualified'] );
		$this->assertSame( 1, $referral['rewarded'] );
		$this->assertSame( 0.5, $referral['qualificationRate'] );
		$this->assertSame( 100, $referral['rewardPointsIssued'] );
	}
}
