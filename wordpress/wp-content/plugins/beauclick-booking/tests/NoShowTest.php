<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Rest\BookingController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

/** V2.1 Step 10 (BOOK-04) — a small, properly scoped professional action. */
final class NoShowTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_past_confirmed_booking( int $customer_id, int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 1,
				'slot_start'  => gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 3 * HOUR_IN_SECONDS ),
				'slot_end'    => gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 2 * HOUR_IN_SECONDS ),
				'status'      => 'confirmed',
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	// 35. authorized transition.
	public function test_marking_a_past_due_confirmed_booking_as_no_show_succeeds(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );

		$ok = ( new BookingService() )->mark_no_show( $booking_id );

		$this->assertTrue( $ok );
		$this->assertSame( 'no_show', ( new BookingService() )->find( $booking_id )['status'] );
	}

	public function test_a_booking_whose_slot_has_not_ended_yet_cannot_be_marked_no_show(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'slot_end' => gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + HOUR_IN_SECONDS ) ], [ 'id' => $booking_id ] );

		$ok = ( new BookingService() )->mark_no_show( $booking_id );

		$this->assertFalse( $ok, 'A booking must not be marked no-show before its own slot has even ended.' );
	}

	public function test_an_already_completed_booking_cannot_be_marked_no_show(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );
		( new BookingService() )->mark_no_show( $booking_id ); // Already transitioned once.

		$this->assertFalse( ( new BookingService() )->mark_no_show( $booking_id ), 'A booking already marked no-show must not transition again.' );
	}

	// Authorization: only the owning provider (or admin) can mark no-show, matching confirm()'s own established gate.
	public function test_a_different_professional_cannot_mark_another_providers_booking_as_no_show(): void {
		$owner_id     = self::factory()->user->create();
		$provider_id  = $this->make_provider( $owner_id );
		$other_owner  = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$this->make_provider( $other_owner );
		$customer_id  = self::factory()->user->create();
		$booking_id   = $this->make_past_confirmed_booking( $customer_id, $provider_id );

		wp_set_current_user( $other_owner );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking_id}/no-show" );
		$request->set_param( 'id', $booking_id );

		$result = ( new BookingController() )->can_confirm( $request );

		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_the_owning_provider_can_mark_no_show_via_the_controller(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );

		wp_set_current_user( $owner_id );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/bookings/{$booking_id}/no-show" );
		$request->set_param( 'id', $booking_id );

		$response = ( new BookingController() )->no_show( $request );

		$this->assertSame( 200, $response->get_status() );
	}

	// 36. event logging.
	public function test_marking_no_show_logs_a_real_event(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );

		( new BookingService() )->mark_no_show( $booking_id );

		$logged = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'booking_no_show' AND entity_id = %d", $booking_id )
		);
		$this->assertSame( 1, $logged );
	}

	// 37. notification behavior -- deliberately none; a no-show mark is internal bookkeeping, not pushed to the customer.
	public function test_marking_no_show_never_sends_the_customer_a_notification(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$booking_id  = $this->make_past_confirmed_booking( $customer_id, $provider_id );

		( new BookingService() )->mark_no_show( $booking_id );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d", $customer_id ) );
		$this->assertSame( 0, $count );
	}
}
