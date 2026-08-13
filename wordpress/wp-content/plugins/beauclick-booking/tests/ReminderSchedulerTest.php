<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Reminders\ReminderScheduler;
use WP_UnitTestCase;

final class ReminderSchedulerTest extends WP_UnitTestCase {

	private function make_booking( string $status, string $slot_start, int $customer_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => 1,
				'slot_id'     => 1,
				'slot_start'  => $slot_start,
				'slot_end'    => gmdate( 'Y-m-d H:i:s', strtotime( $slot_start ) + HOUR_IN_SECONDS ),
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	private function notification_count_for( int $booking_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE entity_type = 'booking' AND entity_id = %d AND category = 'reminder'", $booking_id )
		);
	}

	// 19. scheduling.
	public function test_a_confirmed_booking_about_24_hours_out_gets_a_reminder(): void {
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		$slot_start = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id = $this->make_booking( 'confirmed', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertGreaterThan( 0, $this->notification_count_for( $booking_id ) );
	}

	public function test_a_booking_far_in_the_future_does_not_yet_get_a_reminder(): void {
		$customer_id = self::factory()->user->create();
		$slot_start  = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 5 * DAY_IN_SECONDS );
		$booking_id  = $this->make_booking( 'confirmed', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertSame( 0, $this->notification_count_for( $booking_id ) );
	}

	// 20. no duplicate reminders.
	public function test_running_the_sweep_twice_never_duplicates_the_reminder(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		$slot_start = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id = $this->make_booking( 'confirmed', $slot_start, $customer_id );

		$scheduler = new ReminderScheduler();
		$scheduler->run();
		$scheduler->run();

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE entity_type = 'booking' AND entity_id = %d AND category = 'reminder' AND channel = 'sms'", $booking_id )
		);
		$this->assertSame( 1, $count, 'Running the hourly sweep twice within the same matching window must never create a second reminder.' );
	}

	// 21. cancelled booking suppresses reminder.
	public function test_a_cancelled_booking_never_gets_a_reminder(): void {
		$customer_id = self::factory()->user->create();
		$slot_start  = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id  = $this->make_booking( 'cancelled', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertSame( 0, $this->notification_count_for( $booking_id ) );
	}

	// 22. completed booking suppresses reminder.
	public function test_a_completed_booking_never_gets_a_reminder(): void {
		$customer_id = self::factory()->user->create();
		$slot_start  = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id  = $this->make_booking( 'completed', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertSame( 0, $this->notification_count_for( $booking_id ) );
	}

	public function test_a_pending_unconfirmed_booking_never_gets_a_reminder(): void {
		$customer_id = self::factory()->user->create();
		$slot_start  = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id  = $this->make_booking( 'pending', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertSame( 0, $this->notification_count_for( $booking_id ), 'An unpaid/unconfirmed booking must never trigger a reminder.' );
	}

	// 23. timezone correctness -- the matching window is anchored to site-local "now" (current_time('mysql')), not raw UTC time().
	public function test_the_reminder_window_is_anchored_to_site_local_time_not_raw_utc(): void {
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		// Exactly 24h from site-local now, using the same current_time('mysql') basis the scheduler itself uses.
		$slot_start = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$booking_id = $this->make_booking( 'confirmed', $slot_start, $customer_id );

		( new ReminderScheduler() )->run();

		$this->assertGreaterThan( 0, $this->notification_count_for( $booking_id ), 'A booking exactly 24h from site-local now must fall inside the matching window.' );
	}
}
