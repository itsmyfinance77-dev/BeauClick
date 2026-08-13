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
}
