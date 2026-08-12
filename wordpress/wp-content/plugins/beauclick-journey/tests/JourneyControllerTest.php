<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Rest\JourneyController;
use WP_UnitTestCase;

final class JourneyControllerTest extends WP_UnitTestCase {

	public function test_a_logged_out_visitor_cannot_reach_the_summary(): void {
		wp_set_current_user( 0 );
		$result = ( new JourneyController() )->require_login();
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_a_logged_in_customer_can_reach_their_own_summary(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$response = ( new JourneyController() )->summary();
		$this->assertSame( 200, $response->get_status() );
	}

	public function test_create_goal_via_the_controller_persists_and_returns_201(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new \WP_REST_Request( 'POST', '/beauclick/v1/journey/goals' );
		$request->set_param( 'title', 'آماده شدن برای عروسی' );
		$request->set_param( 'budget', 2000000 );

		$response = ( new JourneyController() )->create_goal( $request );
		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( 'آماده شدن برای عروسی', $response->get_data()['data']['title'] );
	}

	public function test_a_blank_title_returns_a_400_not_a_fatal_error(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new \WP_REST_Request( 'POST', '/beauclick/v1/journey/goals' );
		$request->set_param( 'title', '' );

		$response = ( new JourneyController() )->create_goal( $request );
		$this->assertSame( 400, $response->get_status() );
	}

	/**
	 * The core authorization boundary the task explicitly requires:
	 * "Customer A cannot access Customer B's journey."
	 */
	public function test_a_customer_cannot_edit_another_customers_goal(): void {
		$owner   = self::factory()->user->create();
		$stranger = self::factory()->user->create();
		$goal    = ( new GoalService() )->create( $owner, 'هدف مالک', null, null, null, null );

		wp_set_current_user( $stranger );
		$request = new \WP_REST_Request( 'PATCH', "/beauclick/v1/journey/goals/{$goal['id']}" );
		$request->set_param( 'id', $goal['id'] );

		$controller = new JourneyController();
		$permission = $controller->can_edit_goal( $request );

		$this->assertInstanceOf( \WP_Error::class, $permission, "A stranger must never be authorized to edit another customer's goal." );
	}

	public function test_the_owning_customer_can_edit_their_own_goal(): void {
		$owner = self::factory()->user->create();
		$goal  = ( new GoalService() )->create( $owner, 'هدف مالک', null, null, null, null );

		wp_set_current_user( $owner );
		$request = new \WP_REST_Request( 'PATCH', "/beauclick/v1/journey/goals/{$goal['id']}" );
		$request->set_param( 'id', $goal['id'] );

		$this->assertTrue( ( new JourneyController() )->can_edit_goal( $request ) );
	}

	public function test_a_nonexistent_goal_id_does_not_leak_ownership_information_through_the_permission_check(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new \WP_REST_Request( 'PATCH', '/beauclick/v1/journey/goals/999999' );
		$request->set_param( 'id', 999999 );

		// Permission passes through so the handler can 404 -- the interesting
		// failure is "not found", not "forbidden", same convention as
		// MyProfileController::can_edit_service().
		$this->assertTrue( ( new JourneyController() )->can_edit_goal( $request ) );
	}

	public function test_summary_endpoint_scopes_data_to_the_authenticated_user_only(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();

		wp_set_current_user( $user_a );
		( new GoalService() )->create( $user_a, 'هدف اختصاصی الف', null, null, null, null );

		wp_set_current_user( $user_b );
		$response = ( new JourneyController() )->summary();
		$data     = $response->get_data()['data'];

		$this->assertSame( [], $data['activeGoals'], "User B's own summary request must never surface user A's goal." );
	}

	public function test_timeline_endpoint_paginates_via_page_and_per_page_params(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$goals = new GoalService();
		for ( $i = 0; $i < 3; $i++ ) {
			$goals->create( $user_id, "هدف {$i}", null, null, null, null );
		}

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/journey/timeline' );
		$request->set_param( 'per_page', 2 );
		$request->set_param( 'page', 1 );

		$response = ( new JourneyController() )->timeline( $request );
		$this->assertCount( 2, $response->get_data()['data'] );
	}
}
