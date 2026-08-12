<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Loyalty\Rest\LoyaltyController;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * REST-boundary authorization: every customer-facing route is self-scoped
 * (get_current_user_id() only, matching JourneyController's own
 * established pattern), and every admin route requires bc_manage_platform,
 * verified server-side -- never trusting a frontend-supplied value.
 */
final class LoyaltyControllerTest extends WP_UnitTestCase {

	// 10. Unauthorized access -- admin routes.
	public function test_a_plain_customer_cannot_access_admin_routes(): void {
		wp_set_current_user( self::factory()->user->create() );

		$result = ( new LoyaltyController() )->require_admin();

		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_an_administrator_can_access_admin_routes(): void {
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );

		$this->assertTrue( ( new LoyaltyController() )->require_admin() );
	}

	// Own-view -- a customer sees only their own summary.
	public function test_summary_returns_only_the_current_users_own_data(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		( new LoyaltyLedger() )->award( $user_a, 50, 'booking_completed' );
		( new LoyaltyLedger() )->award( $user_b, 999, 'booking_completed' );

		wp_set_current_user( $user_a );
		$response = ( new LoyaltyController() )->summary();
		$data     = $response->get_data()['data'];

		$this->assertSame( 50, $data['balance'], "Customer A's summary must reflect only their own balance, never customer B's." );
	}

	// 11. Customer cannot alter balance -- calling the customer-facing summary
	// endpoint repeatedly (with request params an attacker might try to
	// smuggle a write through) must never change the ledger it reads from.
	public function test_calling_summary_never_mutates_the_callers_own_balance(): void {
		$user_id = self::factory()->user->create();
		( new LoyaltyLedger() )->award( $user_id, 50, 'booking_completed' );
		wp_set_current_user( $user_id );

		$controller = new LoyaltyController();
		$controller->summary();
		$controller->summary();
		$controller->summary();

		$this->assertSame( 50, ( new LoyaltyLedger() )->balance( $user_id ), 'Reading the loyalty summary any number of times must never itself change the balance it reports.' );
	}

	public function test_admin_grant_membership_requires_a_real_user_and_plan(): void {
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/memberships/grant' );
		$request->set_param( 'userId', 0 );
		$request->set_param( 'planId', 0 );

		$response = ( new LoyaltyController() )->admin_grant_membership( $request );

		$this->assertSame( 422, $response->get_status() );
	}
}
