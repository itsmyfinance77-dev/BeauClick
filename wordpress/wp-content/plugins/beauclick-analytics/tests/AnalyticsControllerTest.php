<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tests;

use BeauClick\Analytics\Rest\AnalyticsController;
use WP_REST_Request;
use WP_UnitTestCase;

final class AnalyticsControllerTest extends WP_UnitTestCase {

	// 1. the dashboard data source is admin-only — analytics can reveal
	// real business volume/revenue, per this step's own §20 instruction.
	public function test_require_admin_denies_a_plain_customer(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		wp_set_current_user( $user_id );

		$result = ( new AnalyticsController() )->require_admin();

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	// 2. an administrator (holds bc_manage_platform) is allowed through.
	public function test_require_admin_allows_a_platform_administrator(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $user_id );

		$this->assertTrue( ( new AnalyticsController() )->require_admin() );
	}

	// 3. track() must reject any event name not on the explicit allowlist —
	// this endpoint must never become a general "log any event" sink a
	// client could use to forge analytics data.
	public function test_track_rejects_an_event_not_on_the_allowlist(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/analytics/track' );
		$request->set_param( 'event', 'totally_made_up_event' );

		$response = ( new AnalyticsController() )->track( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( 'bc_invalid_event', $response->get_data()['error']['code'] );
	}

	// 4. a real allow-listed event logs against the CURRENT user, never a
	// client-supplied user id.
	public function test_track_logs_an_allowlisted_event_for_the_current_user(): void {
		global $wpdb;

		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/analytics/track' );
		$request->set_param( 'event', 'crm_opened' );

		$response = ( new AnalyticsController() )->track( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertTrue( $response->get_data()['data']['tracked'] );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT event_type, actor_id FROM {$wpdb->prefix}bc_events WHERE event_type = 'crm_opened' AND actor_id = %d", $user_id ),
			ARRAY_A
		);
		$this->assertNotNull( $row );
	}

	// 5. overview() returns every documented section for a valid admin request.
	public function test_overview_returns_every_section(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'GET', '/beauclick/v1/analytics/overview' );
		$response = ( new AnalyticsController() )->overview( $request );
		$data     = $response->get_data()['data'];

		foreach ( [ 'overview', 'funnel', 'commerce', 'search', 'ai', 'retention', 'usage', 'marketplace' ] as $section ) {
			$this->assertArrayHasKey( $section, $data );
		}
	}
}
