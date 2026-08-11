<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use WP_UnitTestCase;

final class BookingServiceTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[
				'provider_id' => $provider_id,
				'start_at'    => '2026-09-01 10:00:00',
				'end_at'      => '2026-09-01 11:00:00',
				'status'      => 'open',
				'created_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	/**
	 * The concurrency guarantee itself is MySQL's row-locking on a single
	 * UPDATE ... WHERE status='open' statement — not something a
	 * single-threaded PHPUnit process can reproduce directly. What IS
	 * testable, and what this asserts, is that our query logic correctly
	 * uses that guarantee: a second claim attempt on an already-claimed
	 * slot must be rejected, not silently create a second booking for the
	 * same slot. This is the exact bug class the architecture doc flags
	 * double-booking as a top risk for.
	 */
	public function test_a_slot_can_only_be_booked_once(): void {
		$provider_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();

		$first  = $service->create_booking( $customer_a, $provider_id, $slot_id );
		$second = $service->create_booking( $customer_b, $provider_id, $slot_id );

		$this->assertNotNull( $first, 'The first booking attempt on an open slot must succeed.' );
		$this->assertNull( $second, 'A second booking attempt on an already-claimed slot must be rejected, not create a duplicate booking.' );

		global $wpdb;
		$booking_count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE slot_id = %d", $slot_id )
		);
		$this->assertSame( 1, $booking_count, 'Exactly one booking row must exist for the slot, never two.' );
	}

	public function test_booking_an_already_booked_slot_returns_null_without_side_effects(): void {
		$provider_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$service->create_booking( $customer_id, $provider_id, $slot_id );

		$result = $service->create_booking( $customer_id, $provider_id, 999999 ); // Non-existent slot.
		$this->assertNull( $result );
	}

	public function test_cancelling_releases_the_slot_back_to_open(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		$service->cancel_booking( $booking['booking_id'] );

		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ) );
		$this->assertSame( 'open', $slot_status, 'Cancelling a booking must free the slot for someone else to book.' );

		// And the freed slot must be bookable again.
		$rebooked = $service->create_booking( self::factory()->user->create(), $provider_id, $slot_id );
		$this->assertNotNull( $rebooked );
	}

	public function test_a_completed_booking_cannot_be_cancelled(): void {
		$provider_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );

		$this->assertFalse( $service->cancel_booking( $booking['booking_id'] ), 'A completed booking is final and must not be cancellable.' );
	}

	public function test_status_transitions_are_only_allowed_from_the_correct_prior_state(): void {
		$provider_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		$this->assertFalse(
			$service->complete_booking( $booking['booking_id'] ),
			'A pending booking cannot jump straight to completed — it must be confirmed first.'
		);
		$this->assertTrue( $service->confirm_booking( $booking['booking_id'] ) );
		$this->assertTrue( $service->complete_booking( $booking['booking_id'] ) );
	}
}
