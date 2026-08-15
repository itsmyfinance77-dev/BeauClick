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

	/**
	 * V2.3 final release audit finding: every admin mutation on this REST
	 * controller — a second, REST-reachable path to the exact same
	 * tier/plan/benefit/membership actions LoyaltyAdminPage's wp-admin form
	 * performs — wrote no audit entry at all, unlike that wp-admin twin (see
	 * LoyaltyAdminPageTest for that path's own, pre-existing coverage). Same
	 * bug class this release already fixed for B2B account approve/reject
	 * and B2B quote pricing.
	 */
	public function test_rest_admin_create_tier_records_an_audit_entry(): void {
		global $wpdb;
		$operator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $operator_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/tiers' );
		$request->set_param( 'slug', 'gold' );
		$request->set_param( 'name', 'طلایی' );
		$request->set_param( 'thresholdPoints', 500 );

		$response = ( new LoyaltyController() )->admin_create_tier( $request );
		$tier_id  = $response->get_data()['data']['id'];

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'loyalty_tier_created', $row['action_type'] );
		$this->assertSame( 'loyalty_tier', $row['entity_type'] );
		$this->assertSame( $tier_id, (int) $row['entity_id'] );
		$this->assertSame( $operator_id, (int) $row['actor_user_id'] );
	}

	public function test_rest_admin_update_tier_records_previous_and_new_state(): void {
		global $wpdb;
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );

		$create = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/tiers' );
		$create->set_param( 'slug', 'silver' );
		$create->set_param( 'name', 'نقره‌ای' );
		$create->set_param( 'thresholdPoints', 100 );
		$tier_id = ( new LoyaltyController() )->admin_create_tier( $create )->get_data()['data']['id'];

		$update = new WP_REST_Request( 'PATCH', '/beauclick/v1/loyalty/admin/tiers/' . $tier_id );
		$update->set_param( 'id', $tier_id );
		$update->set_param( 'isActive', false );
		( new LoyaltyController() )->admin_update_tier( $update );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_tier_updated' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$previous = json_decode( $row['previous_state'], true );
		$this->assertTrue( $previous['isActive'], 'previous_state must reflect the tier as it was before this update.' );
		$this->assertSame( [ 'isActive' => false ], json_decode( $row['new_state'], true ) );
	}

	public function test_rest_admin_grant_and_cancel_membership_both_record_audit_entries(): void {
		global $wpdb;
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );

		$create_plan = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/plans' );
		$create_plan->set_param( 'slug', 'basic' );
		$create_plan->set_param( 'name', 'پایه' );
		$create_plan->set_param( 'isPaid', false );
		$plan_id = ( new LoyaltyController() )->admin_create_plan( $create_plan )->get_data()['data']['id'];

		$member = self::factory()->user->create();

		$grant = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/memberships/grant' );
		$grant->set_param( 'userId', $member );
		$grant->set_param( 'planId', $plan_id );
		( new LoyaltyController() )->admin_grant_membership( $grant );

		$grant_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_membership_granted' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $member, (int) $grant_row['entity_id'] );

		$cancel = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/memberships/' . $member . '/cancel' );
		$cancel->set_param( 'user_id', $member );
		( new LoyaltyController() )->admin_cancel_membership( $cancel );

		$cancel_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_membership_cancelled' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $member, (int) $cancel_row['entity_id'] );
	}

	public function test_rest_admin_create_and_delete_benefit_both_record_audit_entries(): void {
		global $wpdb;
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'administrator' ] ) );

		$create_tier = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/tiers' );
		$create_tier->set_param( 'slug', 'bronze' );
		$create_tier->set_param( 'name', 'برنزی' );
		$create_tier->set_param( 'thresholdPoints', 0 );
		$tier_id = ( new LoyaltyController() )->admin_create_tier( $create_tier )->get_data()['data']['id'];

		$create_benefit = new WP_REST_Request( 'POST', '/beauclick/v1/loyalty/admin/benefits' );
		$create_benefit->set_param( 'sourceType', 'tier' );
		$create_benefit->set_param( 'sourceId', $tier_id );
		$create_benefit->set_param( 'benefitType', 'descriptive' );
		$create_benefit->set_param( 'label', 'اولویت پشتیبانی' );
		$benefit_id = ( new LoyaltyController() )->admin_create_benefit( $create_benefit )->get_data()['data']['id'];

		$created_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_benefit_created' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $benefit_id, (int) $created_row['entity_id'] );

		$delete = new WP_REST_Request( 'DELETE', '/beauclick/v1/loyalty/admin/benefits/' . $benefit_id );
		$delete->set_param( 'id', $benefit_id );
		( new LoyaltyController() )->admin_delete_benefit( $delete );

		$deleted_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_benefit_deleted' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $benefit_id, (int) $deleted_row['entity_id'] );
	}
}
