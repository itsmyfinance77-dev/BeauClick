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

	/**
	 * A production-readiness audit flagged list_own() as an unbounded
	 * query — a customer's entire booking history was returned on every
	 * call. This asserts the per_page cap and pagination metadata actually
	 * take effect, not just that the endpoint still returns bookings.
	 */
	public function test_list_own_is_capped_and_reports_pagination_metadata(): void {
		$customer_id = self::factory()->user->create();
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );

		for ( $i = 0; $i < 3; $i++ ) {
			$slot = $this->make_open_slot( $provider_id );
			( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );
		}

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/booking/bookings' );
		$request->set_param( 'per_page', 2 );
		$response   = ( new BookingController() )->list_own( $request );
		$bookings   = $response->get_data()['data'];
		$pagination = $response->get_data()['meta']->pagination;

		$this->assertCount( 2, $bookings, 'per_page must actually cap the returned rows.' );
		$this->assertSame( 3, $pagination['total'], 'The true total must still be reported even though this page is capped.' );
	}

	/**
	 * A production-readiness audit caught availability() mixing time()
	 * (true UTC) with current_time('mysql') (site-local) for the "next 7
	 * days" window's two ends — under Iran's UTC+3:30 offset (no DST, so
	 * this never self-corrects), that skewed the window by 3.5 hours at
	 * each edge. A slot exactly at "now + 7 days" in site-local time must
	 * be excluded either way (open interval), but the point of this test
	 * is that the window's actual width is a clean 7×24h span from
	 * site-local "now" — not from a different, UTC-based "now".
	 */
	public function test_availability_window_uses_a_consistent_time_base_under_a_non_utc_site_timezone(): void {
		update_option( 'gmt_offset', 3.5 ); // Iran Standard Time, no DST.
		global $wpdb;

		$provider_id = self::factory()->user->create();

		$just_inside  = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 7 * DAY_IN_SECONDS - HOUR_IN_SECONDS );
		$just_outside = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 7 * DAY_IN_SECONDS + HOUR_IN_SECONDS );

		foreach ( [ 'inside' => $just_inside, 'outside' => $just_outside ] as $label => $start ) {
			$wpdb->insert(
				$wpdb->prefix . 'bc_availability_slots',
				[ 'provider_id' => $provider_id, 'start_at' => $start, 'end_at' => $start, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
			);
		}

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/booking/availability' );
		$request->set_param( 'provider_id', $provider_id );
		$slots = ( new BookingController() )->availability( $request )->get_data()['data'];

		$starts = array_column( $slots, 'startAt' );
		$this->assertContains( $just_inside, $starts, 'A slot 1 hour inside the 7-day window (measured from site-local now) must be included.' );
		$this->assertNotContains( $just_outside, $starts, 'A slot 1 hour beyond the 7-day window must be excluded — if the two bounds used different time bases, this could wrongly include it.' );
	}

	// --- V2.2 Step 15 -- reschedule ownership + REST error mapping -----------

	private function make_slot( int $provider_post_id, string $start ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_post_id, 'start_at' => $start, 'end_at' => gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function far_future( int $days = 10 ): string {
		return gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + $days * DAY_IN_SECONDS );
	}

	public function test_the_owning_customer_can_reschedule_their_own_booking_over_rest(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );
		$booking     = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/reschedule" );
		$request->set_param( 'id', $booking['booking_id'] );
		$request->set_param( 'new_slot_id', $new_slot );

		$response = ( new BookingController() )->reschedule( $request );
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( $new_slot, $response->get_data()['data']['slotId'] );
	}

	public function test_an_unrelated_customer_cannot_reschedule_someone_elses_booking(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$stranger_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$booking     = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );

		wp_set_current_user( $stranger_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/reschedule" );
		$request->set_param( 'id', $booking['booking_id'] );

		$this->assertInstanceOf( \WP_Error::class, ( new BookingController() )->can_manage_booking( $request ), 'A customer must never be able to reschedule a booking that is not their own.' );
	}

	public function test_the_owning_professional_can_reschedule_a_booking_they_manage(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );

		wp_set_current_user( $owner_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/reschedule" );
		$request->set_param( 'id', $booking['booking_id'] );

		$this->assertTrue( ( new BookingController() )->can_manage_booking( $request ) );
	}

	public function test_reschedule_error_codes_map_to_the_correct_http_status(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );
		( new BookingService() )->complete_booking( $booking['booking_id'] ); // No longer eligible.

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/reschedule" );
		$request->set_param( 'id', $booking['booking_id'] );
		$request->set_param( 'new_slot_id', 999999 );

		$response = ( new BookingController() )->reschedule( $request );
		$this->assertSame( 409, $response->get_status() );
		$this->assertSame( 'bc_reschedule_ineligible', $response->get_data()['error']['code'] );
		$this->assertNotEmpty( $response->get_data()['error']['message'], 'The error message must be a real, non-empty Persian string.' );
	}

	public function test_reschedule_eligibility_endpoint_reports_the_configured_limits(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/booking/bookings/{$booking['booking_id']}/reschedule-eligibility" );
		$request->set_param( 'id', $booking['booking_id'] );

		$data = ( new BookingController() )->reschedule_eligibility( $request )->get_data()['data'];
		$this->assertTrue( $data['eligible'] );
		$this->assertSame( 0, $data['rescheduleCount'] );
	}

	public function test_list_own_reports_the_reschedule_count_without_n_plus_one_queries(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $old_slot );
		( new BookingService() )->confirm_booking( $booking['booking_id'] );
		( new \BeauClick\Booking\Booking\RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		wp_set_current_user( $customer_id );
		$response = ( new BookingController() )->list_own( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/bookings' ) );
		$rows     = $response->get_data()['data'];

		$this->assertSame( 1, $rows[0]['rescheduleCount'] );
	}
}
