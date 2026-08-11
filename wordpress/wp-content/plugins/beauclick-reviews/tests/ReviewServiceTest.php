<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

final class ReviewServiceTest extends WP_UnitTestCase {

	private function make_booking( int $customer_id, int $provider_id, string $status = 'completed' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 1,
				'slot_start'  => '2026-09-01 10:00:00',
				'slot_end'    => '2026-09-01 11:00:00',
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	public function test_a_review_can_be_written_for_a_completed_booking(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		$result = ( new ReviewService() )->create( $customer_id, $booking_id, 5, 'عالی بود' );

		$this->assertIsArray( $result );
		$this->assertSame( 5, $result['rating'] );
		$this->assertSame( 'approved', $result['status'] );
	}

	public function test_a_review_is_rejected_for_a_booking_that_is_not_completed(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id, 'confirmed' );

		$result = ( new ReviewService() )->create( $customer_id, $booking_id, 5, 'زودتر از موعد' );

		$this->assertIsString( $result, 'A booking that has not completed yet must not be reviewable, even if it belongs to the author.' );
	}

	public function test_a_review_is_rejected_for_someone_elses_booking(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$real_customer = self::factory()->user->create();
		$attacker      = self::factory()->user->create();
		$booking_id    = $this->make_booking( $real_customer, $provider_id );

		$result = ( new ReviewService() )->create( $attacker, $booking_id, 1, 'نظر جعلی' );

		$this->assertIsString( $result, "A user must never be able to write a review against someone else's booking." );
	}

	public function test_a_booking_can_only_be_reviewed_once(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		$service = new ReviewService();
		$first   = $service->create( $customer_id, $booking_id, 5, 'اول' );
		$second  = $service->create( $customer_id, $booking_id, 1, 'دوباره' );

		$this->assertIsArray( $first );
		$this->assertIsString( $second, 'A second review against the same booking must be rejected — one booking, one review, forever.' );
	}

	public function test_creating_a_review_resyncs_the_providers_rating_in_the_search_index(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$booking_a   = $this->make_booking( $customer_a, $provider_id );
		$booking_b   = $this->make_booking( $customer_b, $provider_id );

		$service = new ReviewService();
		$service->create( $customer_a, $booking_a, 4, 'خوب' );
		$service->create( $customer_b, $booking_b, 2, 'متوسط' );

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT rating_avg, review_count FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ), ARRAY_A );
		$this->assertSame( 2, (int) $row['review_count'] );
		$this->assertSame( '3.00', $row['rating_avg'], 'rating_avg must be the real average (4+2)/2 = 3, not a placeholder.' );
	}

	public function test_the_owning_professional_can_respond_to_a_review_about_them(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		$service = new ReviewService();
		$review  = $service->create( $customer_id, $booking_id, 5, 'عالی' );

		$this->assertTrue( $service->respond( $review['id'], $owner_id, 'ممنون از اعتمادتون!' ) );
		$this->assertSame( 'ممنون از اعتمادتون!', $service->find( $review['id'] )['response'] );
	}

	public function test_a_different_professional_cannot_respond_to_someone_elses_review(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$other_pro   = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_booking( $customer_id, $provider_id );

		$service = new ReviewService();
		$review  = $service->create( $customer_id, $booking_id, 5, 'عالی' );

		$this->assertFalse( $service->respond( $review['id'], $other_pro, 'این نظر مال من نیست' ) );
	}
}
