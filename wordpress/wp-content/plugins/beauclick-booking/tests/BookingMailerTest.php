<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * Intercepts via the `pre_wp_mail` filter (WP 5.7+) rather than requiring
 * a real mail transport — local dev typically has none configured, same
 * as every other environment without SMTP set up. This asserts the real
 * wp_mail() call BookingService now makes on confirm/cancel, not a mock
 * of some notification abstraction.
 */
final class BookingMailerTest extends WP_UnitTestCase {

	private array $sent = [];

	public function set_up(): void {
		parent::set_up();
		$this->sent = [];
		add_filter( 'pre_wp_mail', [ $this, 'capture' ], 10, 2 );
	}

	public function tear_down(): void {
		remove_filter( 'pre_wp_mail', [ $this, 'capture' ], 10 );
		parent::tear_down();
	}

	public function capture( $null, array $atts ) {
		$this->sent[] = $atts;
		return true; // Short-circuits the real send.
	}

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => '2026-09-01 10:00:00', 'end_at' => '2026-09-01 11:00:00', 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	public function test_confirming_a_booking_emails_the_customer(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );

		$this->assertCount( 1, $this->sent );
		$customer = get_userdata( $customer_id );
		$this->assertSame( $customer->user_email, $this->sent[0]['to'] );
	}

	public function test_cancelling_as_the_customer_only_emails_the_provider(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		wp_set_current_user( $customer_id );
		$service->cancel_booking( $booking['booking_id'] );

		$this->assertCount( 1, $this->sent, 'The customer cancelled — only the provider (who did not act) should be notified, not the customer notifying themselves.' );
		$owner = get_userdata( $owner_id );
		$this->assertSame( $owner->user_email, $this->sent[0]['to'] );
	}

	public function test_cancelling_as_the_provider_only_emails_the_customer(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		wp_set_current_user( $owner_id );
		$service->cancel_booking( $booking['booking_id'] );

		$this->assertCount( 1, $this->sent );
		$customer = get_userdata( $customer_id );
		$this->assertSame( $customer->user_email, $this->sent[0]['to'] );
	}

	public function test_the_automatic_hold_expiry_sweep_does_not_send_any_email(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );

		global $wpdb;
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - MINUTE_IN_SECONDS ) ], [ 'id' => $booking['booking_id'] ] );
		$service->expire_stale_holds();

		$this->assertCount( 0, $this->sent, 'The passive cron sweep cancelling an abandoned hold is not a user-facing cancellation action and must not email anyone.' );
	}
}
