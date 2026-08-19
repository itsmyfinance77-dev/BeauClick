<?php
/**
 * WooCommerce's own stock-availability markup ("49 in stock" / "49 عدد در
 * انبار") renders its count in raw Latin digits — every other number in
 * the product (prices, dates, ratings, review counts) already goes
 * through bc_persian_digits(), found live on the single-product page
 * during this pass's audit. Same fix shape as beauclick-ai's rule-based
 * providers (V2.4 UI audit, LOC-07): convert at the single output point
 * rather than touching WooCommerce core.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || exit;

add_filter(
	'woocommerce_get_stock_html',
	static fn ( string $html ): string => bc_persian_digits( $html ),
	10,
	1
);

// Same gap, found live on the checkout page's order-review table ("شامپو
// ضدریزش × 1") — prices already go through wc_price (beauclick-payments\
// Currency already hooks that one), but a bare item quantity isn't a
// price, so it slipped past that existing filter. Checkout's own review
// table renders this as plain text ('&times;&nbsp;' . quantity), safe to
// convert wholesale — deliberately NOT hooking the cart page's own
// woocommerce_cart_item_quantity filter, which wraps a real, editable
// <input type="number" value="1">: converting its value attribute to a
// Persian digit would silently break quantity editing (the input would
// hold a non-numeric value).
add_filter(
	'woocommerce_checkout_cart_item_quantity',
	static fn ( string $html ): string => bc_persian_digits( $html ),
	10,
	1
);
