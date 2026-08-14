<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Tests;

use BeauClick\B2B\Admin\AccountsAdminPage;
use BeauClick\B2B\Business\BusinessAccountService;
use WP_UnitTestCase;

/**
 * V2.2 Step 13 — B2B approval/rejection must write to the general admin
 * audit log (ADMIN-02). approve_and_log()/reject_and_log() are tested
 * directly (not handle_approve()/handle_reject(), which end in
 * wp_safe_redirect()+exit and can't run inside a test process).
 */
final class AccountsAdminPageTest extends WP_UnitTestCase {

	public function test_approve_and_log_approves_the_account_and_records_an_audit_entry(): void {
		global $wpdb;

		$applicant_id = self::factory()->user->create();
		$account_id   = ( new BusinessAccountService() )->apply( $applicant_id, 'سالن نمونه' );

		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		( new AccountsAdminPage() )->approve_and_log( $account_id );

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

	public function test_reject_and_log_rejects_the_account_and_records_an_audit_entry_with_a_reason(): void {
		global $wpdb;

		$applicant_id = self::factory()->user->create();
		$account_id   = ( new BusinessAccountService() )->apply( $applicant_id, 'سالن نمونه دو' );

		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		( new AccountsAdminPage() )->reject_and_log( $account_id );

		$status = $wpdb->get_var( $wpdb->prepare( "SELECT approval_status FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ) );
		$this->assertSame( BusinessAccountService::STATUS_REJECTED, $status );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'b2b_account_rejected', $row['action_type'] );
		$this->assertNotEmpty( $row['reason'] );
	}
}
