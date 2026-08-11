<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Rest\BookingController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * Covers the REST-layer ownership checks that BookingServiceTest can't —
 * those exercise BookingService directly and never touch
 * ProviderLookup::for_user(), so they couldn't have caught the bug a live
 * verification pass found: bc_bookings.provider_id is the professional's
 * CPT post id, but can_confirm()/cancel()/list_own() previously compared
 * it against get_current_user_id() directly, meaning a real professional
 * (whose post id never equals their own user id) could never confirm or
 * cancel their own bookings, or see them listed at all.
 */
final class BookingControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_open_slot( int $provider_post_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_post_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	public function test_the_owning_professional_can_confirm_their_own_booking(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot        = $this->make_open_slot( $provider_id );
		$booking     = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $owner_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/confirm" );
		$request->set_param( 'id', $booking['booking_id'] );

		$this->assertTrue( ( new BookingController() )->can_confirm( $request ), "The professional who owns the provider post must be able to confirm their own booking — this is the exact case the post-id/user-id mismatch bug broke." );
	}

	public function test_a_different_professional_cannot_confirm_someone_elses_booking(): void {
		$owner_id     = self::factory()->user->create();
		$other_owner  = self::factory()->user->create();
		$provider_id  = $this->make_provider( $owner_id );
		$this->make_provider( $other_owner );
		$customer_id  = self::factory()->user->create();
		$slot         = $this->make_open_slot( $provider_id );
		$booking      = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $other_owner );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/confirm" );
		$request->set_param( 'id', $booking['booking_id'] );

		$this->assertInstanceOf( \WP_Error::class, ( new BookingController() )->can_confirm( $request ) );
	}

	public function test_the_owning_professional_can_cancel_their_own_booking(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot        = $this->make_open_slot( $provider_id );
		$booking     = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $owner_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/cancel" );
		$request->set_param( 'id', $booking['booking_id'] );

		$response = ( new BookingController() )->cancel( $request );
		$this->assertSame( 200, $response->get_status(), "The owning professional must be able to cancel their own booking." );
	}

	public function test_the_owning_professional_sees_their_own_booking_in_list_own(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot        = $this->make_open_slot( $provider_id );
		( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $owner_id );
		$response = ( new BookingController() )->list_own( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/bookings' ) );
		$bookings = $response->get_data()['data'];

		$this->assertCount( 1, $bookings, "The owning professional's own GET /booking/bookings must include their booking, not just the customer's." );
	}

	public function test_a_user_with_no_provider_profile_only_sees_their_own_bookings_as_customer(): void {
		$customer_id = self::factory()->user->create();
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$slot        = $this->make_open_slot( $provider_id );
		( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $customer_id );
		$response = ( new BookingController() )->list_own( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/bookings' ) );
		$bookings = $response->get_data()['data'];

		$this->assertCount( 1, $bookings );
	}
}
