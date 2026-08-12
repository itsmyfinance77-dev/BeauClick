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
}
