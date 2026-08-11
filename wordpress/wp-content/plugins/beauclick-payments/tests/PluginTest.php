<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Payments\Plugin;
use WP_UnitTestCase;

/**
 * A production-readiness audit found WooCommerce's auto-created Shop/
 * Cart/Checkout/My account pages kept their stock English titles even
 * after the site locale was fixed — post_title is literal data written
 * once at page-creation time, not something a locale/translation change
 * touches retroactively.
 */
final class PluginTest extends WP_UnitTestCase {

	public function test_activation_translates_wc_pages_still_on_their_stock_english_title(): void {
		$shop_id = self::factory()->post->create( [ 'post_type' => 'page', 'post_title' => 'Shop' ] );
		update_option( 'woocommerce_shop_page_id', $shop_id );

		Plugin::activate();

		$this->assertSame( 'فروشگاه', get_post( $shop_id )->post_title );
	}

	public function test_activation_never_overwrites_an_admin_customized_page_title(): void {
		$shop_id = self::factory()->post->create( [ 'post_type' => 'page', 'post_title' => 'فروشگاه ویژه من' ] );
		update_option( 'woocommerce_shop_page_id', $shop_id );

		Plugin::activate();

		$this->assertSame( 'فروشگاه ویژه من', get_post( $shop_id )->post_title, "A title an admin already customized (away from WooCommerce's stock 'Shop') must never be silently overwritten." );
	}

	/**
	 * V2.0 Step 1: order_completed applies to every paid order, not just
	 * booking ones -- a real Shop/B2B purchase must write it too.
	 */
	public function test_paying_for_a_real_shop_order_writes_an_order_completed_event(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();

		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'pending' );
		$order->save();

		$order->payment_complete();

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = 'order_completed' AND entity_type = 'order' AND entity_id = %d", $order->get_id() ),
			ARRAY_A
		);
		$this->assertNotNull( $row, 'A real wp_bc_events row must exist for order_completed.' );
		$this->assertSame( (string) $customer_id, $row['actor_id'] );
	}

	/**
	 * woocommerce_payment_complete has no atomic single-fire guarantee of
	 * its own (unlike the booking status transitions elsewhere in this
	 * codebase) -- a re-fired hook for the same order must not write a
	 * second event row.
	 */
	public function test_a_repeated_payment_complete_call_does_not_duplicate_the_order_completed_event(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();

		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'pending' );
		$order->save();

		$order->payment_complete();
		$order->payment_complete(); // Simulates a duplicated webhook/gateway retry.

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'order_completed' AND entity_id = %d", $order->get_id() )
		);
		$this->assertSame( 1, $count, 'A re-fired payment_complete for the same order must not write a second order_completed event.' );
	}

	public function test_refunding_an_order_writes_an_order_refunded_event(): void {
		global $wpdb;
		$customer_id = self::factory()->user->create();

		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'processing' );
		$order->save();

		$order->update_status( 'refunded' );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = 'order_refunded' AND entity_type = 'order' AND entity_id = %d", $order->get_id() ),
			ARRAY_A
		);
		$this->assertNotNull( $row, 'A real wp_bc_events row must exist for order_refunded.' );
	}

	public function test_a_cancelled_order_does_not_write_an_order_refunded_event(): void {
		global $wpdb;
		$order = new \WC_Order();
		$order->set_status( 'processing' );
		$order->save();

		$order->update_status( 'cancelled' );

		$count = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'order_refunded' AND entity_id = %d", $order->get_id() )
		);
		$this->assertSame( 0, $count, 'on_order_dead() also handles cancelled/failed -- only a genuinely refunded status must write order_refunded.' );
	}
}
