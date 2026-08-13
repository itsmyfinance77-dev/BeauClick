<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tests;

use BeauClick\Analytics\Tracking\CommerceTracker;
use WP_UnitTestCase;

final class CommerceTrackerTest extends WP_UnitTestCase {

	// 1. cart_add logs a real event carrying the quantity, keyed to the product.
	public function test_track_cart_add_logs_event_with_quantity(): void {
		global $wpdb;

		( new CommerceTracker() )->track_cart_add( 'some-cart-key', 555, 3 );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT entity_id, meta FROM {$wpdb->prefix}bc_events WHERE event_type = 'cart_add' AND entity_id = %d", 555 ),
			ARRAY_A
		);

		$this->assertNotNull( $row );
		$this->assertSame( [ 'quantity' => 3 ], json_decode( $row['meta'], true ) );
	}

	// 2. product_view must not log outside a real single-product request —
	// this codebase's existing convention (see profile_view) is that a page
	// view is only logged from the page that's actually being viewed, not
	// speculatively on unrelated requests.
	public function test_track_product_view_is_a_noop_outside_a_product_page(): void {
		global $wpdb;

		( new CommerceTracker() )->track_product_view();

		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'product_view'" );
		$this->assertSame( 0, $count );
	}

	// 3. checkout_started must not log when the cart is empty — an empty
	// checkout page visit (or a stray hook fire) is not a real funnel step.
	public function test_track_checkout_started_is_a_noop_with_an_empty_cart(): void {
		global $wpdb;

		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			$this->markTestSkipped( 'WooCommerce cart is not initialized in this test environment.' );
		}

		WC()->cart->empty_cart();
		( new CommerceTracker() )->track_checkout_started();

		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'checkout_started'" );
		$this->assertSame( 0, $count );
	}
}
