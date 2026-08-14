<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\Admin\LoyaltyAdminPage;
use WP_UnitTestCase;

/**
 * V2.2 Step 13 — every commercial config change made through this admin
 * page (tier/plan/benefit CRUD, membership grant/cancel) must write to the
 * general admin audit log (ADMIN-02). Each "*_and_log()" method is tested
 * directly (not the admin-post.php handle_*() wrappers, which end in
 * wp_safe_redirect()+exit and can't run inside a test process).
 */
final class LoyaltyAdminPageTest extends WP_UnitTestCase {

	private function as_operator(): int {
		$operator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $operator_id );
		return $operator_id;
	}

	public function test_create_tier_and_log_records_an_audit_entry(): void {
		global $wpdb;
		$operator_id = $this->as_operator();

		$page = new LoyaltyAdminPage();
		$tier_id = $page->create_tier_and_log( 'gold', 'طلایی', 500 );

		$this->assertIsInt( $tier_id );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'loyalty_tier_created', $row['action_type'] );
		$this->assertSame( $tier_id, (int) $row['entity_id'] );
		$this->assertSame( $operator_id, (int) $row['actor_user_id'] );
	}

	public function test_create_tier_and_log_does_not_record_an_audit_entry_on_validation_failure(): void {
		global $wpdb;
		$this->as_operator();

		$result = ( new LoyaltyAdminPage() )->create_tier_and_log( '', '', 100 );

		$this->assertIsString( $result, 'An empty slug/name must be rejected with a Persian error string.' );
		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );
		$this->assertSame( 0, $count );
	}

	public function test_toggle_tier_and_log_records_previous_and_new_state(): void {
		global $wpdb;
		$this->as_operator();

		$page    = new LoyaltyAdminPage();
		$tier_id = $page->create_tier_and_log( 'silver', 'نقره‌ای', 100 );

		$page->toggle_tier_and_log( $tier_id );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_tier_toggled' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$this->assertSame( [ 'isActive' => true ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'isActive' => false ], json_decode( $row['new_state'], true ) );
	}

	public function test_grant_and_cancel_membership_and_log_both_record_audit_entries(): void {
		global $wpdb;
		$this->as_operator();

		$page    = new LoyaltyAdminPage();
		$plan_id = $page->create_plan_and_log( 'basic', 'پایه', null, false, null );
		$this->assertIsInt( $plan_id );

		$member = self::factory()->user->create( [ 'user_email' => 'member@example.test' ] );

		$grant_error = $page->grant_membership_and_log( 'member@example.test', $plan_id );
		$this->assertNull( $grant_error );

		$grant_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_membership_granted' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $member, (int) $grant_row['entity_id'] );

		$cancel_error = $page->cancel_membership_and_log( 'member@example.test' );
		$this->assertNull( $cancel_error );

		$cancel_row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_membership_cancelled' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( $member, (int) $cancel_row['entity_id'] );
	}

	public function test_grant_membership_and_log_returns_an_error_and_logs_nothing_for_an_unknown_email(): void {
		global $wpdb;
		$this->as_operator();

		$error = ( new LoyaltyAdminPage() )->grant_membership_and_log( 'nobody@example.test', 1 );

		$this->assertIsString( $error );
		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'loyalty_membership_granted'" );
		$this->assertSame( 0, $count );
	}
}
