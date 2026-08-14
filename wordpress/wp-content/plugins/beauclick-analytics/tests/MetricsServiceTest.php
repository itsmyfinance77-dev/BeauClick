<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tests;

use BeauClick\Analytics\Metrics\MetricsService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class MetricsServiceTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id, string $post_type = Registrar::PROFESSIONAL ): int {
		return self::factory()->post->create( [ 'post_type' => $post_type, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_booking( int $provider_id, int $customer_id, string $status, ?int $service_id = null ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'service_id'  => $service_id,
				'slot_id'     => 0,
				'slot_start'  => current_time( 'mysql' ),
				'slot_end'    => current_time( 'mysql' ),
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return (int) $wpdb->insert_id;
	}

	private function log_event( string $type, int $booking_id, ?int $actor_id = null ): void {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_events',
			[ 'event_type' => $type, 'entity_type' => 'booking', 'entity_id' => $booking_id, 'actor_id' => $actor_id, 'created_at' => current_time( 'mysql' ) ]
		);
	}

	private function range_today(): array {
		$today = current_time( 'Y-m-d' );
		return [ $today, $today ];
	}

	// 3. Metrics match source data.
	public function test_provider_funnel_counts_only_this_providers_own_bookings(): void {
		$owner_a = self::factory()->user->create();
		$owner_b = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$provider_b = $this->make_provider( $owner_b );
		$customer = self::factory()->user->create();

		$booking_a = $this->make_booking( $provider_a, $customer, 'created' );
		$this->log_event( 'booking_created', $booking_a );
		$booking_b = $this->make_booking( $provider_b, $customer, 'created' );
		$this->log_event( 'booking_created', $booking_b );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_a, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 1, $result['funnel']['started'], 'Provider A must only see their own booking_created events, not provider B\'s.' );
	}

	public function test_provider_funnel_includes_rescheduled_bucket(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer = self::factory()->user->create();
		$booking_id = $this->make_booking( $provider_id, $customer, 'confirmed' );
		$this->log_event( 'booking_reschedule_succeeded', $booking_id );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 1, $result['funnel']['rescheduled'] );
	}

	public function test_platform_wide_funnel_also_reports_a_rescheduled_bucket(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer = self::factory()->user->create();
		$booking_id = $this->make_booking( $provider_id, $customer, 'confirmed' );
		$this->log_event( 'booking_reschedule_succeeded', $booking_id );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->funnel( $from, $to );

		$this->assertGreaterThanOrEqual( 1, $result['rescheduled'], 'The platform-wide funnel must include a rescheduled bucket (V2.2 Step 16 addition), not silently omit Step 15\'s own events.' );
	}

	public function test_profile_views_are_scoped_to_the_exact_provider_post(): void {
		$owner_a = self::factory()->user->create();
		$owner_b = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$provider_b = $this->make_provider( $owner_b );

		global $wpdb;
		$wpdb->insert( $wpdb->prefix . 'bc_events', [ 'event_type' => 'profile_view', 'entity_type' => Registrar::PROFESSIONAL, 'entity_id' => $provider_a, 'created_at' => current_time( 'mysql' ) ] );
		$wpdb->insert( $wpdb->prefix . 'bc_events', [ 'event_type' => 'profile_view', 'entity_type' => Registrar::PROFESSIONAL, 'entity_id' => $provider_b, 'created_at' => current_time( 'mysql' ) ] );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_a, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 1, $result['profileViews'] );
	}

	public function test_review_average_and_count_are_scoped_to_the_provider(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$other_provider = $this->make_provider( self::factory()->user->create() );

		global $wpdb;
		$now = current_time( 'mysql' );
		$customer_a = self::factory()->user->create();
		$customer_b = self::factory()->user->create();
		$customer_c = self::factory()->user->create();
		$booking_a  = $this->make_booking( $provider_id, $customer_a, 'completed' );
		$booking_b  = $this->make_booking( $provider_id, $customer_b, 'completed' );
		$booking_c  = $this->make_booking( $other_provider, $customer_c, 'completed' );
		$wpdb->insert( $wpdb->prefix . 'bc_reviews', [ 'author_id' => $customer_a, 'target_type' => 'provider', 'target_id' => $provider_id, 'booking_id' => $booking_a, 'rating' => 5, 'status' => 'approved', 'created_at' => $now, 'updated_at' => $now ] );
		$wpdb->insert( $wpdb->prefix . 'bc_reviews', [ 'author_id' => $customer_b, 'target_type' => 'provider', 'target_id' => $provider_id, 'booking_id' => $booking_b, 'rating' => 3, 'status' => 'approved', 'created_at' => $now, 'updated_at' => $now ] );
		$wpdb->insert( $wpdb->prefix . 'bc_reviews', [ 'author_id' => $customer_c, 'target_type' => 'provider', 'target_id' => $other_provider, 'booking_id' => $booking_c, 'rating' => 1, 'status' => 'approved', 'created_at' => $now, 'updated_at' => $now ] );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 2, $result['reviews']['count'] );
		$this->assertSame( 4.0, $result['reviews']['avgRating'] );
	}

	public function test_repeat_customers_are_counted_correctly(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$repeat_customer = self::factory()->user->create();
		$one_time_customer = self::factory()->user->create();

		$this->make_booking( $provider_id, $repeat_customer, 'completed' );
		$this->make_booking( $provider_id, $repeat_customer, 'completed' );
		$this->make_booking( $provider_id, $one_time_customer, 'completed' );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 2, $result['customers']['total'] );
		$this->assertSame( 1, $result['customers']['repeat'] );
	}

	public function test_service_performance_ranks_by_completed_bookings(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$service_a = self::factory()->post->create( [ 'post_type' => Registrar::SERVICE, 'post_title' => 'میکاپ', 'post_parent' => $provider_id ] );
		$service_b = self::factory()->post->create( [ 'post_type' => Registrar::SERVICE, 'post_title' => 'اصلاح ابرو', 'post_parent' => $provider_id ] );
		$customer = self::factory()->user->create();

		$this->make_booking( $provider_id, $customer, 'completed', $service_a );
		$this->make_booking( $provider_id, $customer, 'completed', $service_a );
		$this->make_booking( $provider_id, $customer, 'completed', $service_b );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( $service_a, $result['servicePerformance'][0]['serviceId'], 'The service with more completed bookings must rank first.' );
		$this->assertSame( 2, $result['servicePerformance'][0]['completedCount'] );
	}

	// 4. Date filtering correct.
	public function test_events_outside_the_date_range_are_excluded(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer = self::factory()->user->create();
		$booking_id = $this->make_booking( $provider_id, $customer, 'created' );

		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_events',
			[ 'event_type' => 'booking_created', 'entity_type' => 'booking', 'entity_id' => $booking_id, 'created_at' => gmdate( 'Y-m-d H:i:s', time() - 40 * DAY_IN_SECONDS ) ]
		);

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 0, $result['funnel']['started'], 'An event 40 days outside today\'s range must not be counted.' );
	}

	public function test_a_provider_with_no_activity_gets_all_zero_metrics_not_an_error(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );

		[ $from, $to ] = $this->range_today();
		$result = ( new MetricsService() )->for_provider( $provider_id, Registrar::PROFESSIONAL, $from, $to );

		$this->assertSame( 0, $result['funnel']['started'] );
		$this->assertSame( 0, $result['profileViews'] );
		$this->assertSame( 0, $result['customers']['total'] );
		$this->assertSame( [], $result['servicePerformance'] );
	}
}
