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
}
