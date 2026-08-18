<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Tests;

use BeauClick\Notifications\NotificationService;
use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Notifications\Templates\TemplateRegistry;
use WP_UnitTestCase;

final class NotificationServiceTest extends WP_UnitTestCase {

	public function set_up(): void {
		parent::set_up();
		add_filter( 'pre_wp_mail', [ $this, 'succeed_email' ], 10, 2 );
	}

	public function tear_down(): void {
		remove_filter( 'pre_wp_mail', [ $this, 'succeed_email' ], 10 );
		parent::tear_down();
	}

	public function succeed_email() {
		return true;
	}

	private function make_customer_with_phone(): int {
		$user_id = self::factory()->user->create();
		update_user_meta( $user_id, '_billing_phone', '09121234567' );
		return $user_id;
	}

	// 10. notification creation.
	public function test_notify_creates_a_record_per_requested_channel(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();

		( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 1, [ 'sms', 'email' ] );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d", $user_id ) );
		$this->assertSame( 2, $count );
	}

	// 11. template rendering + 18. Persian content.
	public function test_template_rendering_substitutes_variables_with_real_persian_text(): void {
		$rendered = TemplateRegistry::render( TemplateRegistry::BOOKING_REMINDER, [ 'providerName' => 'سارا احمدی', 'when' => 'فردا ساعت ۱۰' ] );

		$this->assertNotNull( $rendered );
		$this->assertStringContainsString( 'سارا احمدی', $rendered['sms'] );
		$this->assertStringContainsString( 'فردا ساعت ۱۰', $rendered['sms'] );
		$this->assertMatchesRegularExpression( '/[\x{0600}-\x{06FF}]/u', $rendered['sms'], 'The rendered SMS body must contain real Persian script.' );
		$this->assertStringNotContainsString( '<', $rendered['sms'], 'SMS body must never contain HTML markup.' );
	}

	public function test_rendering_an_unknown_template_key_returns_null(): void {
		$this->assertNull( TemplateRegistry::render( 'not_a_real_template', [] ) );
		$result = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, 'not_a_real_template', self::factory()->user->create(), [], 'booking', 1, [ 'sms' ] );
		$this->assertSame( 'invalid_template', $result['sms'] );
	}

	// 12. channel selection.
	public function test_only_the_requested_channels_are_dispatched(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();

		( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 2, [ 'email' ] );

		$channels = $wpdb->get_col( $wpdb->prepare( "SELECT channel FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND entity_id = %d", $user_id, 2 ) );
		$this->assertSame( [ 'email' ], $channels );
	}

	// 13. preference filtering.
	public function test_a_disabled_category_is_suppressed_and_never_actually_dispatched(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();
		( new PreferenceService() )->update( $user_id, [ PreferenceService::CATEGORY_REMINDER => false ] );

		$results = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 3, [ 'sms' ] );

		$this->assertSame( 'suppressed', $results['sms'] );
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT status, recipient FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND entity_id = %d", $user_id, 3 ), ARRAY_A );
		$this->assertSame( 'suppressed', $row['status'] );
		$this->assertNull( $row['recipient'], 'A suppressed notification must never have actually attempted delivery (no recipient recorded).' );
	}

	public function test_an_enabled_category_still_dispatches_normally(): void {
		$user_id = $this->make_customer_with_phone();
		( new PreferenceService() )->update( $user_id, [ PreferenceService::CATEGORY_REMINDER => true ] );

		$results = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 4, [ 'sms' ] );

		$this->assertSame( 'sent', $results['sms'] );
	}

	// 14. idempotency.
	public function test_notifying_twice_with_the_same_entity_never_creates_a_second_row(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();

		( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 5, [ 'sms' ] );
		$second = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 5, [ 'sms' ] );

		$this->assertSame( 'duplicate', $second['sms'] );
		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND entity_id = %d", $user_id, 5 ) );
		$this->assertSame( 1, $count, 'A retried/duplicated notify() call for the same entity+channel must never create a second row.' );
	}

	public function test_a_different_channel_for_the_same_entity_is_not_treated_as_a_duplicate(): void {
		$user_id = $this->make_customer_with_phone();

		$first  = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 6, [ 'sms' ] );
		$second = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 6, [ 'email' ] );

		$this->assertSame( 'sent', $first['sms'] );
		$this->assertSame( 'sent', $second['email'] );
	}

	// 16. failure state.
	public function test_a_user_with_no_phone_on_file_fails_the_sms_channel_with_a_real_reason(): void {
		global $wpdb;
		$user_id = self::factory()->user->create(); // No _billing_phone set.

		$results = ( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'x', 'when' => 'y' ], 'booking', 7, [ 'sms' ] );

		$this->assertSame( 'failed', $results['sms'] );
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT error FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND entity_id = %d", $user_id, 7 ), ARRAY_A );
		$this->assertSame( 'no_phone', $row['error'] );
	}

	// 15. retry.
	public function test_retry_failed_re_attempts_a_transient_failure_and_increments_attempts(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();
		$wpdb->insert(
			$wpdb->prefix . 'bc_notifications',
			[ 'user_id' => $user_id, 'category' => 'reminder', 'template_key' => 'booking_reminder', 'channel' => 'email', 'status' => 'failed', 'error' => 'wp_mail_failed', 'attempts' => 1, 'idempotency_key' => 'retry-test-key', 'created_at' => current_time( 'mysql' ) ]
		);

		$retried = ( new NotificationService() )->retry_failed();

		$this->assertSame( 1, $retried );
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT status, attempts FROM {$wpdb->prefix}bc_notifications WHERE idempotency_key = %s", 'retry-test-key' ), ARRAY_A );
		$this->assertSame( 'sent', $row['status'] );
		$this->assertSame( '2', $row['attempts'] );
	}

	public function test_retry_failed_never_retries_a_permanent_failure(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$wpdb->insert(
			$wpdb->prefix . 'bc_notifications',
			[ 'user_id' => $user_id, 'category' => 'reminder', 'template_key' => 'booking_reminder', 'channel' => 'sms', 'status' => 'failed', 'error' => 'no_phone', 'attempts' => 1, 'idempotency_key' => 'permanent-fail-key', 'created_at' => current_time( 'mysql' ) ]
		);

		$retried = ( new NotificationService() )->retry_failed();

		$this->assertSame( 0, $retried, 'no_phone is a permanent failure -- retrying can never change whether the user has a phone number on file.' );
	}

	public function test_retry_failed_stops_after_the_maximum_attempt_count(): void {
		global $wpdb;
		$user_id = $this->make_customer_with_phone();
		$wpdb->insert(
			$wpdb->prefix . 'bc_notifications',
			[ 'user_id' => $user_id, 'category' => 'reminder', 'template_key' => 'booking_reminder', 'channel' => 'email', 'status' => 'failed', 'error' => 'wp_mail_failed', 'attempts' => 3, 'idempotency_key' => 'maxed-out-key', 'created_at' => current_time( 'mysql' ) ]
		);

		$retried = ( new NotificationService() )->retry_failed();

		$this->assertSame( 0, $retried, 'A notification must not be retried forever -- it must stop once the max attempt count is reached.' );
	}

	// V2.2 Step 14 — account deletion's notification-history handling.
	public function test_forget_user_scrubs_recipient_but_keeps_the_delivery_record(): void {
		global $wpdb;
		$user_id = self::factory()->user->create();
		$wpdb->insert(
			$wpdb->prefix . 'bc_notifications',
			[ 'user_id' => $user_id, 'category' => 'reminder', 'template_key' => 'booking_reminder', 'channel' => 'email', 'status' => 'sent', 'recipient' => 'real-email@example.test', 'attempts' => 1, 'idempotency_key' => 'forget-test-key', 'created_at' => current_time( 'mysql' ) ]
		);

		( new NotificationService() )->forget_user( $user_id );

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_notifications WHERE idempotency_key = %s", 'forget-test-key' ), ARRAY_A );
		$this->assertNotNull( $row, 'The delivery record itself must be retained -- only the recipient PII is scrubbed.' );
		$this->assertNull( $row['recipient'] );
		$this->assertSame( 'sent', $row['status'], 'Operational fields (status/category/timing) must survive unchanged.' );
	}

	public function test_forget_user_is_idempotent(): void {
		$user_id = self::factory()->user->create();
		$service = new NotificationService();

		$service->forget_user( $user_id ); // No rows for this user -- must not error.
		$service->forget_user( $user_id );

		$this->assertTrue( true ); // Reaching here without a fatal is the assertion.
	}

	// V2.4 Step 24 (notification center): a freshly-dispatched notification
	// has never been seen in the UI yet -- read_at starts NULL, unread_count
	// includes it, for_user() reports isRead=false.
	public function test_a_fresh_notification_is_unread_by_default(): void {
		$user_id = $this->make_customer_with_phone();
		$service = new NotificationService();
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 1, [ 'sms' ] );

		$this->assertSame( 1, $service->unread_count( $user_id ) );

		$items = $service->for_user( $user_id );
		$this->assertFalse( $items[0]['isRead'] );
		$this->assertIsInt( $items[0]['id'], 'for_user() must expose a real id -- required for mark_read() to target a specific row.' );
	}

	public function test_mark_read_reduces_the_unread_count_and_is_reflected_in_for_user(): void {
		$user_id = $this->make_customer_with_phone();
		$service = new NotificationService();
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 1, [ 'sms' ] );
		$id = $service->for_user( $user_id )[0]['id'];

		$marked = $service->mark_read( $id, $user_id );

		$this->assertTrue( $marked );
		$this->assertSame( 0, $service->unread_count( $user_id ) );
		$this->assertTrue( $service->for_user( $user_id )[0]['isRead'] );
	}

	/** Ownership: mark_read() must never let one user mark another user's notification read, even by guessing a valid id. */
	public function test_mark_read_refuses_a_notification_belonging_to_a_different_user(): void {
		$owner_id   = $this->make_customer_with_phone();
		$other_id   = self::factory()->user->create();
		$service    = new NotificationService();
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $owner_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 1, [ 'sms' ] );
		$id = $service->for_user( $owner_id )[0]['id'];

		$marked = $service->mark_read( $id, $other_id );

		$this->assertFalse( $marked, 'A non-owner mark_read() attempt must report false, not silently succeed.' );
		$this->assertSame( 1, $service->unread_count( $owner_id ), 'The real owner\'s unread count must be untouched by the other user\'s attempt.' );
	}

	public function test_mark_all_read_clears_every_unread_notification_for_that_user_only(): void {
		$user_id  = $this->make_customer_with_phone();
		$other_id = $this->make_customer_with_phone();
		$service  = new NotificationService();
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 1, [ 'sms' ] );
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'پس‌فردا' ], 'booking', 2, [ 'sms' ] );
		$service->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $other_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 3, [ 'sms' ] );

		$service->mark_all_read( $user_id );

		$this->assertSame( 0, $service->unread_count( $user_id ) );
		$this->assertSame( 1, $service->unread_count( $other_id ), 'mark_all_read() must never touch another user\'s notifications.' );
	}

	/**
	 * V2.4 Step 24: NotificationRequested is fired for every real dispatch
	 * attempt -- zero production subscribers today (same as this codebase's
	 * own otp_generated precedent), but the hook itself must genuinely fire,
	 * not merely exist as an aspiration in a docblock.
	 */
	public function test_notification_requested_hook_fires_with_the_real_dispatch_facts(): void {
		$user_id = $this->make_customer_with_phone();
		$captured = null;
		$listener = static function ( $category, $template_key, $uid, $entity_type, $entity_id, $channel ) use ( &$captured ) {
			$captured = compact( 'category', 'template_key', 'uid', 'entity_type', 'entity_id', 'channel' );
		};
		add_action( 'beauclick/notification/requested', $listener, 10, 6 );

		( new NotificationService() )->notify( PreferenceService::CATEGORY_REMINDER, TemplateRegistry::BOOKING_REMINDER, $user_id, [ 'providerName' => 'سارا', 'when' => 'فردا' ], 'booking', 42, [ 'sms' ] );

		remove_action( 'beauclick/notification/requested', $listener, 10 );

		$this->assertNotNull( $captured );
		$this->assertSame( PreferenceService::CATEGORY_REMINDER, $captured['category'] );
		$this->assertSame( $user_id, $captured['uid'] );
		$this->assertSame( 'booking', $captured['entity_type'] );
		$this->assertSame( 42, $captured['entity_id'] );
		$this->assertSame( 'sms', $captured['channel'] );
	}
}
