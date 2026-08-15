<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Tests;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Rest\B2BController;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * V2.3 Step 20 (ADMIN-05): B2BController::approve_account()/reject_account()
 * are a second, REST-reachable path to the exact same action
 * AccountsAdminPage's wp-admin form performs — this suite proves the audit
 * trail is now complete on this path too, not only the wp-admin one (see
 * AccountsAdminPageTest for that path's own, pre-existing coverage).
 */
final class B2BControllerTest extends WP_UnitTestCase {

	private function make_pending_account(): int {
		$applicant_id = self::factory()->user->create();
		return ( new BusinessAccountService() )->apply( $applicant_id, 'سالن رست' );
	}

	public function test_rest_approve_records_an_audit_entry(): void {
		global $wpdb;

		$account_id   = $this->make_pending_account();
		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/b2b/accounts/' . $account_id . '/approve' );
		$request->set_param( 'id', $account_id );
		( new B2BController() )->approve_account( $request );

		$status = $wpdb->get_var( $wpdb->prepare( "SELECT approval_status FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ) );
		$this->assertSame( BusinessAccountService::STATUS_APPROVED, $status );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'b2b_account_approved', $row['action_type'] );
		$this->assertSame( 'business_account', $row['entity_type'] );
		$this->assertSame( $account_id, (int) $row['entity_id'] );
		$this->assertSame( $moderator_id, (int) $row['actor_user_id'] );
		$this->assertSame( [ 'approval_status' => BusinessAccountService::STATUS_PENDING ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'approval_status' => BusinessAccountService::STATUS_APPROVED ], json_decode( $row['new_state'], true ) );
	}

	public function test_rest_reject_records_an_audit_entry_with_the_callers_own_reason(): void {
		global $wpdb;

		$account_id   = $this->make_pending_account();
		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/b2b/accounts/' . $account_id . '/reject' );
		$request->set_param( 'id', $account_id );
		$request->set_param( 'reason', 'مدارک ناقص است' );
		( new B2BController() )->reject_account( $request );

		$status = $wpdb->get_var( $wpdb->prepare( "SELECT approval_status FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ) );
		$this->assertSame( BusinessAccountService::STATUS_REJECTED, $status );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'b2b_account_rejected', $row['action_type'] );
		// The REST path's own caller-supplied reason must be the one logged —
		// not AccountsAdminPage::reject_and_log()'s hardcoded wp-admin default.
		$this->assertSame( 'مدارک ناقص است', $row['reason'] );
	}
}
