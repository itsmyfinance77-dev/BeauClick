<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Tests;

use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Notifications\Rest\NotificationsController;
use WP_REST_Request;
use WP_UnitTestCase;

final class NotificationsControllerTest extends WP_UnitTestCase {

	public function test_get_preferences_returns_only_the_current_users_own_preferences(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		( new PreferenceService() )->update( $user_a, [ PreferenceService::CATEGORY_REMINDER => false ] );
		( new PreferenceService() )->update( $user_b, [ PreferenceService::CATEGORY_REMINDER => true ] );

		wp_set_current_user( $user_a );
		$data = ( new NotificationsController() )->get_preferences()->get_data()['data'];

		$this->assertFalse( $data[ PreferenceService::CATEGORY_REMINDER ], "Customer A's own disabled preference must be returned, never customer B's." );
	}

	public function test_update_preferences_only_writes_known_category_params(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'PATCH', '/beauclick/v1/notifications/preferences' );
		$request->set_param( PreferenceService::CATEGORY_WAITLIST, false );
		$request->set_param( 'admin_override', true ); // Not a real category -- must be ignored.

		$data = ( new NotificationsController() )->update_preferences( $request )->get_data()['data'];

		$this->assertFalse( $data[ PreferenceService::CATEGORY_WAITLIST ] );
		$this->assertArrayNotHasKey( 'admin_override', $data );
	}

	public function test_a_plain_customer_cannot_access_the_admin_list(): void {
		wp_set_current_user( self::factory()->user->create() );
		$result = ( new NotificationsController() )->require_admin();
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_an_administrator_can_access_the_admin_list(): void {
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );
		$this->assertTrue( ( new NotificationsController() )->require_admin() );
	}

	private function make_notification( int $user_id ): int {
		global $wpdb;
		update_user_meta( $user_id, '_billing_phone', '09121234567' );
		( new \BeauClick\Notifications\NotificationService() )->notify(
			PreferenceService::CATEGORY_REMINDER,
			\BeauClick\Notifications\Templates\TemplateRegistry::BOOKING_REMINDER,
			$user_id,
			[ 'providerName' => 'سارا', 'when' => 'فردا' ],
			'booking',
			1,
			[ 'sms' ]
		);
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d ORDER BY id DESC LIMIT 1", $user_id ) );
	}

	// V2.4 Step 24: the notification center's own REST surface.
	public function test_unread_count_reflects_the_current_users_own_notifications(): void {
		$user_id = self::factory()->user->create();
		$this->make_notification( $user_id );
		wp_set_current_user( $user_id );

		$data = ( new NotificationsController() )->unread_count()->get_data()['data'];

		$this->assertSame( 1, $data['count'] );
	}

	public function test_mark_read_via_rest_reduces_the_unread_count(): void {
		$user_id = self::factory()->user->create();
		$id      = $this->make_notification( $user_id );
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/notifications/' . $id . '/read' );
		$request->set_param( 'id', $id );
		$marked = ( new NotificationsController() )->mark_read( $request )->get_data()['data'];

		$this->assertTrue( $marked['marked'] );
		$this->assertSame( 0, ( new NotificationsController() )->unread_count()->get_data()['data']['count'] );
	}

	public function test_can_mark_own_notification_read_rejects_another_users_notification(): void {
		$owner_id = self::factory()->user->create();
		$other_id = self::factory()->user->create();
		$id       = $this->make_notification( $owner_id );

		wp_set_current_user( $other_id );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/notifications/' . $id . '/read' );
		$request->set_param( 'id', $id );
		$result = ( new NotificationsController() )->can_mark_own_notification_read( $request );

		$this->assertInstanceOf( \WP_Error::class, $result, 'A non-owner must be rejected by the permission check itself, not merely no-op in the handler.' );
	}

	public function test_can_mark_own_notification_read_allows_the_real_owner(): void {
		$owner_id = self::factory()->user->create();
		$id       = $this->make_notification( $owner_id );

		wp_set_current_user( $owner_id );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/notifications/' . $id . '/read' );
		$request->set_param( 'id', $id );
		$result = ( new NotificationsController() )->can_mark_own_notification_read( $request );

		$this->assertTrue( $result );
	}

	public function test_mark_all_read_via_rest_only_affects_the_current_user(): void {
		$user_id  = self::factory()->user->create();
		$other_id = self::factory()->user->create();
		$this->make_notification( $user_id );
		$this->make_notification( $other_id );

		wp_set_current_user( $user_id );
		( new NotificationsController() )->mark_all_read();

		$this->assertSame( 0, ( new NotificationsController() )->unread_count()->get_data()['data']['count'] );
		wp_set_current_user( $other_id );
		$this->assertSame( 1, ( new NotificationsController() )->unread_count()->get_data()['data']['count'] );
	}
}
