<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests\Ranking;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Ranking\SignalCollector;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;
use WP_UnitTestCase;

final class SignalCollectorTest extends WP_UnitTestCase {

	private function make_provider( array $meta = [] ): int {
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		foreach ( $meta as $key => $value ) {
			update_post_meta( $provider_id, $key, $value );
		}
		( new Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );
		return $provider_id;
	}

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	public function test_collect_one_reads_rating_and_verified_from_the_provider_index(): void {
		global $wpdb;
		$provider_id = $this->make_provider( [ '_bc_verification_status' => 'verified' ] );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'rating_avg' => 4.6, 'review_count' => 12 ], [ 'provider_id' => $provider_id ] );

		$signals = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );

		$this->assertNotNull( $signals );
		$this->assertSame( 4.6, $signals->ratingAvg );
		$this->assertSame( 12, $signals->reviewCount );
		$this->assertTrue( $signals->verified );
	}

	public function test_collect_one_returns_null_for_a_provider_not_in_the_index(): void {
		$signals = ( new SignalCollector() )->collect_one( 999999, Registrar::PROFESSIONAL );
		$this->assertNull( $signals );
	}

	public function test_collect_one_counts_completed_and_cancelled_bookings_correctly(): void {
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();
		$service     = new BookingService();

		// One completed booking.
		$slot_a   = $this->make_open_slot( $provider_id );
		$booking_a = $service->create_booking( $customer_id, $provider_id, $slot_a )['booking_id'];
		$service->confirm_booking( $booking_a );
		$service->complete_booking( $booking_a );

		// One cancelled booking.
		$slot_b   = $this->make_open_slot( $provider_id );
		$booking_b = $service->create_booking( $customer_id, $provider_id, $slot_b )['booking_id'];
		$service->cancel_booking( $booking_b );

		$signals = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );

		$this->assertSame( 1, $signals->completedBookings );
		$this->assertSame( 1, $signals->cancelledBookings );
		$this->assertSame( 2, $signals->totalBookingsCreated );
	}

	public function test_collect_one_reads_response_time_from_the_shared_event_log(): void {
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();
		$service     = new BookingService();

		$slot       = $this->make_open_slot( $provider_id );
		$booking_id = $service->create_booking( $customer_id, $provider_id, $slot )['booking_id'];
		$service->confirm_booking( $booking_id );

		$signals = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );

		$this->assertNotNull( $signals->avgResponseSeconds, 'confirm_booking() logs response_time_seconds -- the collector must read it back.' );
		$this->assertGreaterThanOrEqual( 0, $signals->avgResponseSeconds );
	}

	public function test_collect_one_returns_null_response_time_when_no_booking_was_ever_confirmed(): void {
		$provider_id = $this->make_provider();
		$signals     = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );

		$this->assertNull( $signals->avgResponseSeconds );
	}

	/**
	 * profile_view logs entity_type as the CPT post type (bc_professional),
	 * not the literal 'provider' string response_time_seconds/
	 * review_submitted use -- SignalCollector must handle this correctly for
	 * BOTH provider types, not just professionals.
	 */
	public function test_collect_one_reads_profile_views_for_both_provider_types(): void {
		global $wpdb;
		$professional_id = $this->make_provider();
		$business_owner  = self::factory()->user->create();
		$business_id     = self::factory()->post->create( [ 'post_type' => Registrar::BUSINESS, 'post_status' => 'publish', 'post_author' => $business_owner ] );
		( new Indexer() )->sync( $business_id, Registrar::BUSINESS );

		beauclick_core()->events()->log( 'profile_view', Registrar::PROFESSIONAL, $professional_id, null );
		beauclick_core()->events()->log( 'profile_view', Registrar::PROFESSIONAL, $professional_id, null );
		beauclick_core()->events()->log( 'profile_view', Registrar::BUSINESS, $business_id, null );

		$collector = new SignalCollector();
		$pro_signals = $collector->collect_one( $professional_id, Registrar::PROFESSIONAL );
		$biz_signals = $collector->collect_one( $business_id, Registrar::BUSINESS );

		$this->assertSame( 2, $pro_signals->profileViews );
		$this->assertSame( 1, $biz_signals->profileViews );
	}

	public function test_profile_completeness_reflects_bio_thumbnail_portfolio_and_services(): void {
		$provider_id = $this->make_provider();
		$empty_signals = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );
		$this->assertSame( 0.0, $empty_signals->profileCompleteness, 'A freshly-created provider with no bio/thumbnail/portfolio/services must score 0 completeness.' );

		wp_update_post( [ 'ID' => $provider_id, 'post_content' => str_repeat( 'یک بیوگرافی واقعی و معنادار برای تست. ', 3 ) ] );
		self::factory()->post->create( [ 'post_type' => Registrar::SERVICE, 'post_parent' => $provider_id, 'post_status' => 'publish' ] );

		$partial_signals = ( new SignalCollector() )->collect_one( $provider_id, Registrar::PROFESSIONAL );
		$this->assertSame( 0.5, $partial_signals->profileCompleteness, 'Two of four completeness components (bio + service) present must yield exactly 0.5.' );
	}

	public function test_platform_mean_rating_averages_only_providers_with_reviews(): void {
		global $wpdb;
		$with_reviews    = $this->make_provider();
		$without_reviews = $this->make_provider();
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'rating_avg' => 4.4, 'review_count' => 5 ], [ 'provider_id' => $with_reviews ] );

		$mean = ( new SignalCollector() )->platform_mean_rating();

		$this->assertSame( 4.4, $mean, 'A provider with zero reviews must not drag the platform mean toward 0.' );
	}

	public function test_collect_all_returns_signals_for_every_indexed_provider(): void {
		$a = $this->make_provider();
		$b = $this->make_provider();

		$all = ( new SignalCollector() )->collect_all();

		$this->assertArrayHasKey( "{$a}:" . Registrar::PROFESSIONAL, $all );
		$this->assertArrayHasKey( "{$b}:" . Registrar::PROFESSIONAL, $all );
	}
}
