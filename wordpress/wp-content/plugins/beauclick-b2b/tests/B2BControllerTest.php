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

	private function make_product( int $price = 100000 ): int {
		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Product' );
		$product->set_regular_price( (string) $price );
		$product->save();
		return $product->get_id();
	}

	private function make_requested_quote(): array {
		$user_id    = self::factory()->user->create();
		$service    = new BusinessAccountService();
		$account_id = $service->apply( $user_id, 'Test Salon' );
		$service->approve( $account_id );
		$product_id = $this->make_product();
		$quote_id   = ( new \BeauClick\B2B\Business\QuoteService() )->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 20 ] ] );
		return [ $quote_id, $product_id ];
	}

	/**
	 * V2.3 final release audit finding: B2BController::submit_quote_prices()
	 * — the REST route QuotesAdminPage's own docblock says "has existed since
	 * Phase 7 with no UI ever calling it at all" — wrote no audit entry even
	 * after Step 20 added QuotesAdminPage's wp-admin twin (which does log).
	 * Same bug class as approve/reject above, fixed the same way.
	 */
	public function test_rest_submit_quote_prices_records_an_audit_entry(): void {
		global $wpdb;
		[ $quote_id, $product_id ] = $this->make_requested_quote();

		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/b2b/quotes/' . $quote_id . '/quote' );
		$request->set_param( 'id', $quote_id );
		$request->set_param( 'items', [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 90000 ] ] );
		( new B2BController() )->submit_quote_prices( $request );

		$quote = ( new \BeauClick\B2B\Business\QuoteService() )->find( $quote_id );
		$this->assertSame( \BeauClick\B2B\Business\QuoteService::STATUS_QUOTED, $quote['status'] );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'b2b_quote_priced', $row['action_type'] );
		$this->assertSame( 'quote', $row['entity_type'] );
		$this->assertSame( $quote_id, (int) $row['entity_id'] );
		$this->assertSame( $moderator_id, (int) $row['actor_user_id'] );
		$this->assertSame( [ 'status' => \BeauClick\B2B\Business\QuoteService::STATUS_REQUESTED ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'status' => \BeauClick\B2B\Business\QuoteService::STATUS_QUOTED ], json_decode( $row['new_state'], true ) );
	}

	public function test_rest_submit_quote_prices_does_not_record_an_audit_entry_when_pricing_fails(): void {
		global $wpdb;
		[ $quote_id, $product_id ] = $this->make_requested_quote();
		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/b2b/quotes/' . $quote_id . '/quote' );
		$request->set_param( 'id', $quote_id );
		$request->set_param( 'items', [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 90000 ] ] );
		( new B2BController() )->submit_quote_prices( $request );
		$before_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );

		// Pricing an already-quoted quote a second time must fail.
		$second = new WP_REST_Request( 'POST', '/beauclick/v1/b2b/quotes/' . $quote_id . '/quote' );
		$second->set_param( 'id', $quote_id );
		$second->set_param( 'items', [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 95000 ] ] );
		( new B2BController() )->submit_quote_prices( $second );

		$after_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );
		$this->assertSame( $before_count, $after_count, 'A failed pricing attempt must not write a second audit entry.' );
	}
}
