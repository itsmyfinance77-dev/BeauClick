<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Tests;

use BeauClick\Financial\Admin\FinancialAdminPage;
use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use WP_UnitTestCase;

/**
 * Every financial admin action must produce a real audit entry (task §25).
 * Each "*_and_log()" method is tested directly, never the admin-post.php
 * handle_*() wrappers (which end in wp_safe_redirect()+exit and can't run
 * inside a test process) -- same convention `LoyaltyAdminPageTest`/
 * `CampaignAdminPageTest` already established.
 */
final class FinancialAdminPageTest extends WP_UnitTestCase {

	private function as_operator(): int {
		$operator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $operator_id );
		return $operator_id;
	}

	public function set_up(): void {
		parent::set_up();
		CommissionConfig::set_rate( 15 );
	}

	// 1. Creating a settlement records an audit entry with the real actor and the real order ids.
	public function test_settle_and_log_records_an_audit_entry(): void {
		global $wpdb;
		$operator_id = $this->as_operator();

		( new LedgerService() )->record_payment( 601, 701, LedgerService::PARTY_PROFESSIONAL, 81, 400000 );

		$page = new FinancialAdminPage();
		$id   = $page->settle_and_log( LedgerService::PARTY_PROFESSIONAL, 81, [ 601 ], 'انتقال بانکی', null, null );

		$this->assertIsInt( $id );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'financial_settlement_created', $row['action_type'] );
		$this->assertSame( 'financial', $row['entity_type'] );
		$this->assertSame( $id, (int) $row['entity_id'] );
		$this->assertSame( $operator_id, (int) $row['actor_user_id'] );
	}

	// 2. A failed settlement attempt (no outstanding balance) logs nothing.
	public function test_settle_and_log_does_not_record_an_audit_entry_on_failure(): void {
		global $wpdb;
		$this->as_operator();

		$result = ( new FinancialAdminPage() )->settle_and_log( LedgerService::PARTY_PROFESSIONAL, 82, [ 999999 ], null, null, null );

		$this->assertIsString( $result );
		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'financial_settlement_created'" );
		$this->assertSame( 0, $count );
	}

	// 3. Reversing a settlement records previous/new state.
	public function test_reverse_and_log_records_previous_and_new_status(): void {
		global $wpdb;
		$this->as_operator();

		( new LedgerService() )->record_payment( 602, 702, LedgerService::PARTY_PROFESSIONAL, 83, 400000 );
		$page = new FinancialAdminPage();
		$id   = $page->settle_and_log( LedgerService::PARTY_PROFESSIONAL, 83, [ 602 ], null, null, null );

		$page->reverse_and_log( $id, 'اشتباه بود' );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'financial_settlement_reversed' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$this->assertSame( [ 'status' => 'recorded' ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( 'reversed', json_decode( $row['new_state'], true )['status'] );
	}

	// 4. Changing the commission rate records an audit entry with previous/new rate.
	public function test_set_rate_and_log_records_previous_and_new_rate(): void {
		global $wpdb;
		$this->as_operator();
		CommissionConfig::set_rate( 15 );

		( new FinancialAdminPage() )->set_rate_and_log( 20 );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'financial_commission_rate_changed' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$this->assertSame( [ 'rate' => 15 ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'rate' => 20 ], json_decode( $row['new_state'], true ) );
		$this->assertSame( 20, CommissionConfig::rate() );
	}
}
