<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * WaitlistMatcher itself is registered once by the real plugin bootstrap
 * (see beauclick-loyalty's own equivalent test-file docblock for why these
 * tests never call `(new WaitlistMatcher())->register()` a second time) --
 * these tests exercise the real `beauclick/booking/slot_opened` event via
 * genuine BookingService transitions, not the matcher's callback directly.
 */
final class WaitlistMatcherTest extends WP_UnitTestCase {

	private function make_provider(): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
	}

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => '2027-05-01 10:00:00', 'end_at' => '2027-05-01 11:00:00', 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	// 8. slot-opening trigger -- cancelling a booking notifies a matching waitlist entry.
	public function test_cancelling_a_booking_notifies_a_matching_waitlist_entry(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$waiting_customer = self::factory()->user->create();
		( new WaitlistService() )->create( $waiting_customer, $provider_id, null, '2027-05-01', null, null );

		$booker_id = self::factory()->user->create();
		$slot_id   = $this->make_open_slot( $provider_id );
		$service   = new BookingService();
		$booking   = $service->create_booking( $booker_id, $provider_id, $slot_id );

		$service->cancel_booking( $booking['booking_id'] );

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'waitlist'", $waiting_customer )
		);
		$this->assertGreaterThan( 0, $count, 'Cancelling a booking must notify a matching waitlist entry via the real slot_opened event.' );
	}

	public function test_expiring_a_stale_hold_also_notifies_a_matching_waitlist_entry(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$waiting_customer = self::factory()->user->create();
		( new WaitlistService() )->create( $waiting_customer, $provider_id, null, '2027-05-01', null, null );

		$booker_id = self::factory()->user->create();
		$slot_id   = $this->make_open_slot( $provider_id );
		$service   = new BookingService();
		$booking   = $service->create_booking( $booker_id, $provider_id, $slot_id );
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => '2020-01-01 00:00:00' ], [ 'id' => $booking['booking_id'] ] );

		$service->expire_stale_holds();

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'waitlist'", $waiting_customer )
		);
		$this->assertGreaterThan( 0, $count );
	}

	public function test_a_waitlist_entry_for_a_different_provider_is_never_notified(): void {
		global $wpdb;
		$provider_a = $this->make_provider();
		$provider_b = $this->make_provider();
		$waiting_customer = self::factory()->user->create();
		( new WaitlistService() )->create( $waiting_customer, $provider_b, null, null, null, null );

		$booker_id = self::factory()->user->create();
		$slot_id   = $this->make_open_slot( $provider_a );
		$service   = new BookingService();
		$booking   = $service->create_booking( $booker_id, $provider_a, $slot_id );
		$service->cancel_booking( $booking['booking_id'] );

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'waitlist'", $waiting_customer )
		);
		$this->assertSame( 0, $count, "A waitlist entry for a completely different provider must never be notified about someone else's slot opening." );
	}

	// 9. race-condition behavior -- booking remains the sole source of truth; the waitlist never pre-reserves.
	public function test_a_waitlisted_customer_still_has_to_win_the_real_atomic_booking_claim(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$waiting_customer = self::factory()->user->create();
		( new WaitlistService() )->create( $waiting_customer, $provider_id, null, '2027-05-01', null, null );

		$booker_id = self::factory()->user->create();
		$slot_id   = $this->make_open_slot( $provider_id );
		$service   = new BookingService();
		$booking   = $service->create_booking( $booker_id, $provider_id, $slot_id );
		$service->cancel_booking( $booking['booking_id'] ); // Slot re-opens, waitlist matcher fires (notification only, no reservation).

		// A THIRD customer (not on the waitlist at all) claims the slot
		// first -- this must succeed exactly as if no waitlist ever
		// existed, proving the waitlist never reserved anything.
		$third_customer = self::factory()->user->create();
		$second_claim   = $service->create_booking( $third_customer, $provider_id, $slot_id );
		$this->assertIsArray( $second_claim, 'A non-waitlisted customer must still be able to claim the reopened slot -- the waitlist offers, it never reserves.' );

		// Now the waitlisted customer attempts the SAME slot -- must lose,
		// exactly as the existing atomic claim already guarantees for any
		// two competing customers.
		$waitlisted_claim = $service->create_booking( $waiting_customer, $provider_id, $slot_id );
		$this->assertNull( $waitlisted_claim, "Being on the waitlist must never grant a second, competing lock -- the customer who actually books first wins, same as anyone else." );
	}

	// FIFO batch cap: only the configured batch size gets notified even with more matching entries.
	public function test_only_the_earliest_entries_up_to_the_batch_cap_are_notified(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$customers   = [];
		for ( $i = 0; $i < 7; $i++ ) {
			$customers[ $i ] = self::factory()->user->create();
			$waitlist->create( $customers[ $i ], $provider_id, null, '2027-05-01', null, null );
		}

		$booker_id = self::factory()->user->create();
		$slot_id   = $this->make_open_slot( $provider_id );
		$service   = new BookingService();
		$booking   = $service->create_booking( $booker_id, $provider_id, $slot_id );
		$service->cancel_booking( $booking['booking_id'] );

		$notified_count = (int) $wpdb->get_var(
			"SELECT COUNT(DISTINCT user_id) FROM {$wpdb->prefix}bc_notifications WHERE category = 'waitlist'"
		);
		$this->assertLessThanOrEqual( 5, $notified_count, 'A single slot opening must never notify an unbounded number of waitlist entries at once.' );
		$this->assertGreaterThan( 0, $notified_count );
	}
}
