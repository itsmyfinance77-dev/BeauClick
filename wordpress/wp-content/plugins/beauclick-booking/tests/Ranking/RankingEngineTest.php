<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests\Ranking;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Ranking\RankingEngine;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

final class RankingEngineTest extends WP_UnitTestCase {

	private function make_provider(): int {
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		( new Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );
		return $provider_id;
	}

	private function index_row( int $provider_id ): array {
		global $wpdb;
		return $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
	}

	public function test_recompute_one_writes_a_real_score_and_signals_into_the_provider_index(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'verified' => 1, 'rating_avg' => 4.9, 'review_count' => 30 ], [ 'provider_id' => $provider_id ] );

		( new RankingEngine() )->recompute_one( $provider_id, Registrar::PROFESSIONAL );

		$row = $this->index_row( $provider_id );
		$this->assertNotNull( $row['ranking_score'] );
		$this->assertGreaterThan( 0.0, (float) $row['ranking_score'] );
		$signals = (array) json_decode( (string) $row['ranking_signals'], true );
		$this->assertContains( 'verified', $signals );
		$this->assertContains( 'high_rating', $signals );
	}

	public function test_recompute_one_does_nothing_for_a_provider_not_in_the_index(): void {
		// Must not fatal/throw for an id that was never indexed.
		( new RankingEngine() )->recompute_one( 999999, Registrar::PROFESSIONAL );
		$this->assertTrue( true );
	}

	public function test_recompute_all_updates_every_indexed_provider(): void {
		$a = $this->make_provider();
		$b = $this->make_provider();

		$count = ( new RankingEngine() )->recompute_all();

		$this->assertGreaterThanOrEqual( 2, $count );
		$this->assertNotNull( $this->index_row( $a )['ranking_score'] );
		$this->assertNotNull( $this->index_row( $b )['ranking_score'] );
	}

	/**
	 * The real hook wiring in beauclick-booking\Plugin::boot() -- creating a
	 * new provider (which fires save_post_bc_professional -> Indexer::sync()
	 * -> the new beauclick/marketplace/provider_indexed hook) must result in
	 * a real, non-null ranking_score without any explicit recompute call,
	 * proving the cross-plugin seam is actually wired, not just present in
	 * isolated unit tests.
	 */
	public function test_creating_a_provider_triggers_a_real_ranking_score_via_the_provider_indexed_hook(): void {
		$provider_id = $this->make_provider();

		$row = $this->index_row( $provider_id );
		$this->assertNotNull( $row['ranking_score'], 'Publishing a provider must trigger a real ranking computation via the provider_indexed hook, not leave ranking_score NULL until the next cron tick.' );
	}

	public function test_completing_a_booking_triggers_a_ranking_recompute_via_the_booking_completed_hook(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();

		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		$slot_id = $wpdb->insert_id;

		$service    = new BookingService();
		$booking_id = $service->create_booking( $customer_id, $provider_id, $slot_id )['booking_id'];
		$service->confirm_booking( $booking_id );

		// Reset to a known state to prove the NEXT event (completion) is
		// what re-triggers the recompute, not residual state from creation.
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'ranking_score' => null, 'ranking_signals' => null ], [ 'provider_id' => $provider_id ] );

		$service->complete_booking( $booking_id );

		$row = $this->index_row( $provider_id );
		$this->assertNotNull( $row['ranking_score'], 'Completing a booking must trigger a real ranking recompute via beauclick/booking/completed.' );
	}

	public function test_submitting_a_review_triggers_a_ranking_recompute_via_the_reviews_submitted_hook(): void {
		global $wpdb;
		if ( ! class_exists( ReviewService::class ) ) {
			$this->markTestSkipped( 'beauclick-reviews not active.' );
		}

		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();

		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		$slot_id = $wpdb->insert_id;

		$service    = new BookingService();
		$booking_id = $service->create_booking( $customer_id, $provider_id, $slot_id )['booking_id'];
		$service->confirm_booking( $booking_id );
		$service->complete_booking( $booking_id );

		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'ranking_score' => null, 'ranking_signals' => null ], [ 'provider_id' => $provider_id ] );

		( new ReviewService() )->create( $customer_id, $booking_id, 5, 'عالی بود' );

		$row = $this->index_row( $provider_id );
		$this->assertNotNull( $row['ranking_score'], 'Submitting a review must trigger a real ranking recompute via beauclick/reviews/submitted.' );
	}

	/**
	 * Not a strict upper bound on query count (this is a functional
	 * regression guard, not a micro-benchmark) -- just proof that
	 * recompute_all() does bulk/GROUP BY aggregate queries rather than
	 * issuing the same handful of booking/event queries once PER provider
	 * (an O(n) query multiplier that would show up immediately at real
	 * provider-count scale).
	 */
	public function test_recompute_all_does_not_multiply_its_aggregate_query_count_per_provider(): void {
		global $wpdb;
		for ( $i = 0; $i < 5; $i++ ) {
			$this->make_provider();
		}

		$before = $wpdb->num_queries;
		( new RankingEngine() )->recompute_all();
		$queries_for_five = $wpdb->num_queries - $before;

		for ( $i = 0; $i < 5; $i++ ) {
			$this->make_provider();
		}

		$before = $wpdb->num_queries;
		( new RankingEngine() )->recompute_all();
		$queries_for_ten = $wpdb->num_queries - $before;

		// The bulk aggregate queries (bookings, events, provider_index,
		// platform mean) are a small fixed set regardless of N; only the
		// per-provider profile-completeness WP-API lookups genuinely scale
		// with provider count (documented, intentional -- see
		// RankingEngine's own docblock). Doubling providers must not
		// roughly double the TOTAL query count, since the fixed aggregate
		// portion doesn't scale.
		$this->assertLessThan( $queries_for_five * 2, $queries_for_ten, 'recompute_all() must not scale linearly with provider count on its aggregate (non-per-provider) queries.' );
	}
}
