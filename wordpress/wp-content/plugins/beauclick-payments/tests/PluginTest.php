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
	 * Global date/error localization audit: found live on the real "pay for
	 * order" page -- WooCommerce's checkout privacy notice is a literal
	 * option value set once at install time, not translated live via .mo
	 * files, so it stays in English regardless of site locale unless
	 * something rewrites it.
	 */
	public function test_activation_translates_the_checkout_privacy_text_still_on_its_stock_english_default(): void {
		delete_option( 'woocommerce_checkout_privacy_policy_text' );
		update_option(
			'woocommerce_checkout_privacy_policy_text',
			sprintf( 'Your personal data will be used to process your order, support your experience throughout this website, and for other purposes described in our %s.', '[privacy_policy]' )
		);

		Plugin::activate();

		$this->assertStringContainsString( 'اطلاعات شخصی شما', get_option( 'woocommerce_checkout_privacy_policy_text' ) );
	}

	public function test_activation_never_overwrites_an_admin_customized_checkout_privacy_text(): void {
		update_option( 'woocommerce_checkout_privacy_policy_text', 'متن اختصاصی که خودم نوشتم.' );

		Plugin::activate();

		$this->assertSame( 'متن اختصاصی که خودم نوشتم.', get_option( 'woocommerce_checkout_privacy_policy_text' ), 'Text an admin already customized must never be silently overwritten.' );
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

	/**
	 * V2.1 Step 7 -- WooCommerce's own built-in checkout "I agree to the
	 * terms" checkbox only appears once `woocommerce_terms_page_id` points
	 * at a real, published page. beauclick-core's LegalPages deliberately
	 * creates the Terms page as a draft (its legal clauses aren't reviewed
	 * yet), so activation must not wire the option while that remains true.
	 */
	public function test_activation_does_not_configure_the_terms_checkbox_while_the_terms_page_is_still_a_draft(): void {
		self::factory()->post->create( [ 'post_type' => 'page', 'post_name' => 'terms', 'post_status' => 'draft' ] );
		update_option( 'woocommerce_terms_page_id', 0 );

		Plugin::activate();

		$this->assertSame( 0, (int) get_option( 'woocommerce_terms_page_id' ), 'Must never point the checkout consent checkbox at an unreviewed draft.' );
	}

	public function test_activation_configures_the_terms_checkbox_once_the_terms_page_is_published(): void {
		$id = self::factory()->post->create( [ 'post_type' => 'page', 'post_name' => 'terms', 'post_status' => 'publish' ] );
		update_option( 'woocommerce_terms_page_id', 0 );

		Plugin::activate();

		$this->assertSame( $id, (int) get_option( 'woocommerce_terms_page_id' ) );
	}

	public function test_activation_never_overwrites_an_already_configured_terms_page(): void {
		self::factory()->post->create( [ 'post_type' => 'page', 'post_name' => 'terms', 'post_status' => 'publish' ] );
		$other_id = self::factory()->post->create( [ 'post_type' => 'page' ] );
		update_option( 'woocommerce_terms_page_id', $other_id );

		Plugin::activate();

		$this->assertSame( $other_id, (int) get_option( 'woocommerce_terms_page_id' ), 'An admin who already configured a different terms page must not be overridden.' );
	}

	public function test_refund_policy_link_renders_only_once_the_refund_page_is_published(): void {
		self::factory()->post->create( [ 'post_type' => 'page', 'post_name' => 'refund_returns', 'post_status' => 'draft' ] );

		ob_start();
		Plugin::render_refund_policy_link();
		$this->assertSame( '', ob_get_clean(), 'Must never link to a draft/unpublished refund policy from checkout.' );

		wp_update_post( [ 'ID' => get_page_by_path( 'refund_returns' )->ID, 'post_status' => 'publish' ] );

		ob_start();
		Plugin::render_refund_policy_link();
		$output = ob_get_clean();
		$this->assertStringContainsString( '<a href=', $output );
		$this->assertStringContainsString( 'قوانین لغو و بازگشت وجه', $output );
	}
}
