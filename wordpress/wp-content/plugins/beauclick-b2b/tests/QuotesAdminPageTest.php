<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Tests;

use BeauClick\B2B\Admin\QuotesAdminPage;
use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Business\QuoteService;
use WP_UnitTestCase;

/**
 * V2.3 Step 20 (B2B-01): the admin quote-pricing UI is new — before this
 * step, QuoteService::submit_quote_prices() had no caller anywhere except
 * a raw REST request, and no path logged it to the admin audit log.
 * price_and_log() is tested directly (not handle_submit_price(), which
 * ends in wp_safe_redirect()+exit and can't run inside a test process —
 * same split as AccountsAdminPageTest).
 */
final class QuotesAdminPageTest extends WP_UnitTestCase {

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
		$quote_id   = ( new QuoteService() )->request( $account_id, [ [ 'product_id' => $product_id, 'quantity' => 20 ] ] );
		return [ $quote_id, $product_id, $account_id ];
	}

	public function test_price_and_log_prices_the_quote_and_records_an_audit_entry(): void {
		global $wpdb;
		[ $quote_id, $product_id ] = $this->make_requested_quote();

		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		$ok = ( new QuotesAdminPage() )->price_and_log( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 90000 ] ], null );
		$this->assertTrue( $ok );

		$quote = ( new QuoteService() )->find( $quote_id );
		$this->assertSame( QuoteService::STATUS_QUOTED, $quote['status'] );
		$this->assertSame( '1800000', $quote['quoted_total'] );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'b2b_quote_priced', $row['action_type'] );
		$this->assertSame( 'quote', $row['entity_type'] );
		$this->assertSame( $quote_id, (int) $row['entity_id'] );
		$this->assertSame( $moderator_id, (int) $row['actor_user_id'] );
		$this->assertSame( [ 'status' => QuoteService::STATUS_REQUESTED ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'status' => QuoteService::STATUS_QUOTED ], json_decode( $row['new_state'], true ) );
	}

	public function test_price_and_log_does_not_record_an_audit_entry_when_pricing_fails(): void {
		global $wpdb;
		[ $quote_id, $product_id ] = $this->make_requested_quote();
		$moderator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $moderator_id );

		// A quote can only be priced once while still "requested" -- pricing it twice must fail the second time.
		( new QuotesAdminPage() )->price_and_log( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 90000 ] ], null );
		$before_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );

		$ok = ( new QuotesAdminPage() )->price_and_log( $quote_id, [ [ 'product_id' => $product_id, 'quantity' => 20, 'price' => 95000 ] ], null );

		$this->assertFalse( $ok );
		$after_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );
		$this->assertSame( $before_count, $after_count, 'A failed pricing attempt must not write a second audit entry.' );
	}
}
