<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Payments\Currency;
use WP_UnitTestCase;

/**
 * A production-readiness audit found woocommerce_currency had never been
 * configured for this Iran-only platform — Cart/Checkout, wp-admin order
 * screens, order emails, and the Product schema.org JSON-LD WooCommerce
 * outputs automatically were all still showing WooCommerce's stock "$"
 * USD default, while every custom-rendered price elsewhere in the app
 * already used Persian Toman formatting via the theme's bc_format_toman().
 */
final class CurrencyTest extends WP_UnitTestCase {

	public function test_ensure_configured_sets_iranian_currency_formatting(): void {
		Currency::ensure_configured();

		$this->assertSame( 'IRR', get_option( 'woocommerce_currency' ) );
		$this->assertSame( 'right_space', get_option( 'woocommerce_currency_pos' ) );
		$this->assertSame( '٬', get_option( 'woocommerce_price_thousand_sep' ) );
		$this->assertSame( '0', get_option( 'woocommerce_price_num_decimals' ), 'Toman amounts are never fractional in practice.' );
	}

	public function test_the_irr_symbol_is_overridden_to_the_persian_toman_word(): void {
		$currency = new Currency();
		$this->assertSame( 'تومان', $currency->symbol( '$', 'IRR' ) );
	}

	public function test_a_non_irr_currency_symbol_is_left_untouched(): void {
		$currency = new Currency();
		$this->assertSame( '$', $currency->symbol( '$', 'USD' ) );
	}

	public function test_wc_price_output_is_converted_to_persian_digits(): void {
		$currency = new Currency();
		$this->assertSame( '۲٬۵۰۰٬۰۰۰ تومان', $currency->to_persian_digits( '2٬500٬000 تومان' ) );
	}

	public function test_a_real_wc_price_call_renders_persian_digits_and_the_toman_symbol(): void {
		Currency::ensure_configured();
		( new Currency() )->register();

		$html = wc_price( 2500000 );

		$this->assertStringContainsString( 'تومان', $html );
		$this->assertStringContainsString( '۲٬۵۰۰٬۰۰۰', $html );
		$this->assertStringNotContainsString( '$', $html );
	}
}
