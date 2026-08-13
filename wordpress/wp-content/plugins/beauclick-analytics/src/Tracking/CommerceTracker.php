<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tracking;

/**
 * Closes the ANLYT-03 gap (checkout-funnel events not logged) for the
 * genuine WooCommerce cart/checkout path — Shop and B2B bulk-order
 * purchases. Deliberately does NOT touch booking orders: per COM-05's own
 * finding (Product Gap Register), BookingOrderBridge creates orders
 * directly via wc_create_order()+add_product() and never touches
 * WC()->cart at all, so these cart-lifecycle hooks structurally never fire
 * for a booking purchase — booking's own funnel (booking_created ->
 * booking_confirmed -> booking_completed) is already fully covered by
 * existing events (see MetricsService::funnel()). Mixing the two funnels
 * together would double-count and misrepresent both.
 *
 * order_completed/order_refunded are NOT re-logged here — beauclick-payments
 * already wires woocommerce_payment_complete/woocommerce_order_status_*
 * with its own has_logged() dedup guard (see its Plugin.php). Re-hooking
 * the same WooCommerce actions from a second plugin would risk a duplicate,
 * un-guarded event log entry.
 */
final class CommerceTracker {

	public function register(): void {
		add_action( 'template_redirect', [ $this, 'track_product_view' ] );
		add_action( 'woocommerce_add_to_cart', [ $this, 'track_cart_add' ], 10, 3 );
		add_action( 'woocommerce_before_checkout_form', [ $this, 'track_checkout_started' ] );
	}

	/**
	 * No has_logged() dedup guard, deliberately: every real page view of a
	 * product is a genuine, distinct event, not a duplicate to suppress —
	 * the exact same reasoning MarketplaceController::detail() already
	 * documents for profile_view.
	 */
	public function track_product_view(): void {
		if ( ! function_exists( 'is_product' ) || ! is_product() ) {
			return;
		}

		$product_id = get_queried_object_id();
		if ( ! $product_id || ! function_exists( 'beauclick_core' ) ) {
			return;
		}

		beauclick_core()->events()->log( 'product_view', 'product', $product_id, get_current_user_id() ?: null );
	}

	public function track_cart_add( string $cart_item_key, int $product_id, $quantity ): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}

		beauclick_core()->events()->log( 'cart_add', 'product', $product_id, get_current_user_id() ?: null, [ 'quantity' => (int) $quantity ] );
	}

	/**
	 * Logged once per WooCommerce session (not once per page load) via a WC
	 * session flag -- a customer reloading/re-visiting the checkout page
	 * while resolving a validation error would otherwise inflate
	 * "checkout starts" and understate the real start->complete conversion
	 * rate. WC()->session already exists for guests and logged-in
	 * customers alike (WooCommerce's own cookie-based session), so this
	 * needs no new storage.
	 */
	public function track_checkout_started(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->cart || WC()->cart->is_empty() ) {
			return;
		}

		$session = WC()->session;
		if ( $session && $session->get( 'bc_checkout_started_logged' ) ) {
			return;
		}

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log(
				'checkout_started',
				'cart',
				0,
				get_current_user_id() ?: null,
				[ 'itemCount' => WC()->cart->get_cart_contents_count() ]
			);
		}

		if ( $session ) {
			$session->set( 'bc_checkout_started_logged', true );
		}
	}
}
