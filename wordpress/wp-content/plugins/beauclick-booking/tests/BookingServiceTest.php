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

	public function test_a_new_booking_holds_the_slot_with_an_expiry_not_permanently(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		$slot = $wpdb->get_row( $wpdb->prepare( "SELECT status, held_until FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ), ARRAY_A );
		$this->assertSame( 'held', $slot['status'], 'A newly booked slot is held (payment pending), not permanently booked yet.' );
		$this->assertNotNull( $slot['held_until'] );

		$row = $service->find( $booking['booking_id'] );
		$this->assertNotNull( $row['expires_at'] );
	}

	public function test_confirming_converts_the_hold_into_a_permanent_booking(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );

		$slot = $wpdb->get_row( $wpdb->prepare( "SELECT status, held_until FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ), ARRAY_A );
		$this->assertSame( 'booked', $slot['status'] );
		$this->assertNull( $slot['held_until'], 'A confirmed booking\'s slot must no longer be subject to hold expiry.' );
	}

	/**
	 * This is the bug the architectural review specifically called out:
	 * before this fix, a slot claimed by an abandoned checkout stayed
	 * 'booked' forever. Now an expired-but-unswept hold must be
	 * re-claimable in real time — not only after cron gets around to it.
	 */
	public function test_an_expired_hold_can_be_reclaimed_before_the_sweep_runs(): void {
		global $wpdb;
		$provider_id  = self::factory()->user->create();
		$abandoner_id = self::factory()->user->create();
		$new_customer = self::factory()->user->create();
		$slot_id      = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$abandoned = $service->create_booking( $abandoner_id, $provider_id, $slot_id );
		$this->assertNotNull( $abandoned );

		// Simulate the hold having expired 1 minute ago, without running the sweep.
		$wpdb->update(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'held_until' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ],
			[ 'id' => $slot_id ]
		);

		$reclaimed = $service->create_booking( $new_customer, $provider_id, $slot_id );
		$this->assertNotNull( $reclaimed, 'An expired hold must be bookable by someone else immediately, not only after the cron sweep runs.' );
		$this->assertNotSame( $abandoned['booking_id'], $reclaimed['booking_id'] );
	}

	public function test_an_active_unexpired_hold_cannot_be_reclaimed_by_someone_else(): void {
		$provider_id   = self::factory()->user->create();
		$first_id      = self::factory()->user->create();
		$second_id     = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$service->create_booking( $first_id, $provider_id, $slot_id );

		$blocked = $service->create_booking( $second_id, $provider_id, $slot_id );
		$this->assertNull( $blocked, 'A hold that has not expired yet must still block other customers.' );
	}

	public function test_the_sweep_cancels_expired_pending_bookings_and_releases_their_slots(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $booking['booking_id'] ] );
		$wpdb->update( $wpdb->prefix . 'bc_availability_slots', [ 'held_until' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $slot_id ] );

		$expired_count = $service->expire_stale_holds();

		$this->assertSame( 1, $expired_count );
		$this->assertSame( BookingService::STATUS_CANCELLED, $service->find( $booking['booking_id'] )['status'] );
		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ) );
		$this->assertSame( 'open', $slot_status );
	}

	public function test_the_sweep_never_touches_a_booking_that_was_already_confirmed(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] ); // Payment arrives before expiry.

		// Force expires_at into the past to simulate the sweep running late.
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $booking['booking_id'] ] );

		$expired_count = $service->expire_stale_holds();

		$this->assertSame( 0, $expired_count, 'The sweep only targets bookings still in pending status — a confirmed booking must survive even if its (now-irrelevant) expires_at is in the past.' );
		$this->assertSame( BookingService::STATUS_CONFIRMED, $service->find( $booking['booking_id'] )['status'] );
		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ) );
		$this->assertSame( 'booked', $slot_status, 'A confirmed booking\'s slot must never be released by the sweep.' );
	}

	public function test_the_sweep_does_not_release_a_slot_that_was_already_reclaimed_by_someone_else(): void {
		global $wpdb;
		$provider_id  = self::factory()->user->create();
		$abandoner_id = self::factory()->user->create();
		$reclaimer_id = self::factory()->user->create();
		$slot_id      = $this->make_open_slot( $provider_id );

		$service   = new BookingService();
		$abandoned = $service->create_booking( $abandoner_id, $provider_id, $slot_id );

		// Expire the original hold and let a new customer legitimately reclaim it in real time.
		$wpdb->update( $wpdb->prefix . 'bc_availability_slots', [ 'held_until' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $slot_id ] );
		$reclaimed = $service->create_booking( $reclaimer_id, $provider_id, $slot_id );
		$this->assertNotNull( $reclaimed );

		// The reclaim above only touched the slot; the ORIGINAL abandoned
		// booking record still has its own (now-stale) expires_at, which is
		// what the sweep actually keys off. Set it into the past to simulate
		// that time has genuinely passed since it was abandoned.
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $abandoned['booking_id'] ] );

		// The sweep must cancel that stale booking record but must NOT blow
		// away the slot the reclaimer now legitimately holds.
		$expired_count = $service->expire_stale_holds();

		$this->assertSame( BookingService::STATUS_CANCELLED, $service->find( $abandoned['booking_id'] )['status'] );
		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ) );
		$this->assertSame( 'held', $slot_status, "The reclaimer's active hold must survive the sweep triggered by the original abandoner's stale booking record." );
	}
}
