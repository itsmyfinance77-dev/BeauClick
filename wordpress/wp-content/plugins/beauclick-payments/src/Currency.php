<?php
declare( strict_types=1 );

namespace BeauClick\Payments;

/**
 * A production-readiness audit found WooCommerce's currency had never
 * been configured for this Iran-only platform — every custom-rendered
 * price in the app (marketplace, booking, dashboards) already goes
 * through the theme's bc_format_toman() helper and looks correct, but
 * anything WooCommerce renders NATIVELY (Cart/Checkout — real pages since
 * Plugin::ensure_classic_checkout(), wp-admin order screens, order
 * emails, the Product schema.org JSON-LD WooCommerce outputs
 * automatically) was still showing WooCommerce's stock default: "$" USD,
 * 2 decimals, comma thousands separator. Iran has no ISO 4217 code for
 * "Toman" (it's a colloquial ÷10 of the real currency, Rial) — IRR is the
 * closest real currency code, with the *symbol* overridden to the
 * "تومان" text every other price in this product already uses, and the
 * decimal/thousands/digit formatting matched to bc_format_toman() exactly
 * so a price looks identical whether the theme or WooCommerce rendered it.
 */
final class Currency {

	private const PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

	public function register(): void {
		add_filter( 'woocommerce_currency_symbol', [ $this, 'symbol' ], 10, 2 );
		add_filter( 'wc_price', [ $this, 'to_persian_digits' ] );
	}

	public function symbol( string $symbol, string $currency ): string {
		return 'IRR' === $currency ? 'تومان' : $symbol;
	}

	public function to_persian_digits( string $formatted_price ): string {
		return strtr( $formatted_price, [ '0' => self::PERSIAN_DIGITS[0], '1' => self::PERSIAN_DIGITS[1], '2' => self::PERSIAN_DIGITS[2], '3' => self::PERSIAN_DIGITS[3], '4' => self::PERSIAN_DIGITS[4], '5' => self::PERSIAN_DIGITS[5], '6' => self::PERSIAN_DIGITS[6], '7' => self::PERSIAN_DIGITS[7], '8' => self::PERSIAN_DIGITS[8], '9' => self::PERSIAN_DIGITS[9] ] );
	}

	/**
	 * Idempotent — only writes options that differ from the desired state,
	 * safe to call on every activation. Also fixes woocommerce_default_
	 * country/allowed_countries: a production-readiness audit found these
	 * still on WooCommerce's stock default (worldwide, defaulting new
	 * customers to "US:CA") — the country/state dropdown at checkout was
	 * the full world list. Restricted to Iran-only, matching a nationwide-
	 * Iran-only platform; the state field falls back to WooCommerce's own
	 * (limited) Iran state list since it doesn't know about
	 * wp_bc_provinces — a real gap, tracked separately, not fixed here.
	 */
	public static function ensure_configured(): void {
		$desired = [
			'woocommerce_currency'                 => 'IRR',
			'woocommerce_currency_pos'              => 'right_space',
			'woocommerce_price_thousand_sep'        => '٬',
			'woocommerce_price_decimal_sep'         => '.',
			'woocommerce_price_num_decimals'        => '0',
			'woocommerce_default_country'           => 'IR',
			'woocommerce_allowed_countries'         => 'specific',
			'woocommerce_specific_allowed_countries' => [ 'IR' ],
		];

		foreach ( $desired as $option => $value ) {
			if ( get_option( $option ) !== $value ) {
				update_option( $option, $value );
			}
		}
	}
}
