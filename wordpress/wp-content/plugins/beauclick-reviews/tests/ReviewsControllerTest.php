<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Reviews\Reviews\ReviewService;
use BeauClick\Reviews\Rest\ReviewsController;
use WP_UnitTestCase;

final class ReviewsControllerTest extends WP_UnitTestCase {

	public function test_a_logged_out_visitor_cannot_write_a_review(): void {
		wp_set_current_user( 0 );
		$this->assertInstanceOf( \WP_Error::class, ( new ReviewsController() )->can_write() );
	}

	public function test_a_logged_in_customer_can_write_a_review(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$this->assertTrue( ( new ReviewsController() )->can_write() );
	}

	/**
	 * A production-readiness audit found my_reviews() N+1 across a user's
	 * providers before it was switched to a single batched query — this
	 * covers the multi-provider (e.g. B2B) case end to end through the REST
	 * layer, not just the service method in isolation.
	 */
	public function test_my_reviews_covers_every_provider_the_user_owns(): void {
		global $wpdb;
		$owner_id   = self::factory()->user->create();
		$provider_a = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$provider_b = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$customer   = self::factory()->user->create();

		foreach ( [ $provider_a, $provider_b ] as $provider_id ) {
			$booking_id = $wpdb->insert(
				$wpdb->prefix . 'bc_bookings',
				[
					'customer_id' => $customer,
					'provider_id' => $provider_id,
					'slot_id'     => 1,
					'slot_start'  => '2026-09-01 10:00:00',
					'slot_end'    => '2026-09-01 11:00:00',
					'status'      => 'completed',
					'created_at'  => current_time( 'mysql' ),
					'updated_at'  => current_time( 'mysql' ),
				]
			) ? $wpdb->insert_id : 0;
			( new ReviewService() )->create( $customer, $booking_id, 5, "نظر برای {$provider_id}" );
		}

		wp_set_current_user( $owner_id );
		$reviews = ( new ReviewsController() )->my_reviews()->get_data()['data'];

		$this->assertCount( 2, $reviews, "Both of the owner's providers' reviews must be present, not just the first." );
	}
}
