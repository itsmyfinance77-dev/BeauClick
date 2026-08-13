<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Retention\RetentionScheduler;
use BeauClick\Notifications\Preferences\PreferenceService;
use WP_UnitTestCase;

final class RetentionSchedulerTest extends WP_UnitTestCase {

	private function make_booking( int $customer_id, string $status, string $slot_start ): int {
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

	private function notified( int $customer_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'retention'", $customer_id )
		);
	}

	// 31. inactivity detection.
	public function test_a_customer_inactive_past_the_default_window_is_nudged(): void {
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		$this->make_booking( $customer_id, 'completed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 90 * DAY_IN_SECONDS ) );

		( new RetentionScheduler() )->run();

		$this->assertGreaterThan( 0, $this->notified( $customer_id ) );
	}

	public function test_a_recently_active_customer_is_not_nudged(): void {
		$customer_id = self::factory()->user->create();
		$this->make_booking( $customer_id, 'completed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 5 * DAY_IN_SECONDS ) );

		( new RetentionScheduler() )->run();

		$this->assertSame( 0, $this->notified( $customer_id ) );
	}

	// 32. configurable threshold.
	public function test_the_inactivity_window_is_configurable_via_filter(): void {
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		$this->make_booking( $customer_id, 'completed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 10 * DAY_IN_SECONDS ) );

		$filter = static fn () => 5; // Much shorter than the 60-day default.
		add_filter( 'beauclick/booking/inactivity_days', $filter );
		( new RetentionScheduler() )->run();
		remove_filter( 'beauclick/booking/inactivity_days', $filter );

		$this->assertGreaterThan( 0, $this->notified( $customer_id ), 'A shorter, filter-configured inactivity window must be honored instead of the hardcoded default.' );
	}

	// 33. no false positive -- a customer with any upcoming booking (even if their last completed visit was long ago) is not "inactive".
	public function test_a_customer_with_an_upcoming_booking_is_never_a_false_positive(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();
		$this->make_booking( $customer_id, 'completed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 90 * DAY_IN_SECONDS ) );
		$this->make_booking( $customer_id, 'confirmed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 2 * DAY_IN_SECONDS ) );

		( new RetentionScheduler() )->run();

		$this->assertSame( 0, $this->notified( $customer_id ), 'A customer with a real upcoming booking must never be treated as inactive, regardless of how long ago their last completed visit was.' );
	}

	// 34. preference suppression.
	public function test_a_customer_who_disabled_retention_nudges_is_never_actually_delivered_to(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		( new PreferenceService() )->update( $customer_id, [ PreferenceService::CATEGORY_RETENTION => false ] );
		$this->make_booking( $customer_id, 'completed', gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - 90 * DAY_IN_SECONDS ) );

		( new RetentionScheduler() )->run();

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'retention' LIMIT 1", $customer_id ), ARRAY_A );
		$this->assertSame( 'suppressed', $row['status'] );
	}
}
