<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Pricing;

use BeauClick\Campaigns\CampaignService;

/**
 * Releases a campaign's usage slot when the order it was applied to dies —
 * the SAME three WooCommerce order-lifecycle actions
 * `beauclick-payments\Plugin` already listens to
 * (`woocommerce_order_status_cancelled|failed|refunded`), registered here
 * completely independently (multiple plugins can hook the same WooCommerce
 * action; this class never needs to know beauclick-payments' own listener
 * exists, matching this codebase's one-way, hook-based cross-plugin
 * convention). An abandoned booking hold or a genuinely refunded order
 * doesn't unfairly cost a customer their shot at a limited-usage campaign —
 * `usage_limit_total`/`usage_limit_per_customer` only ever count LIVE
 * (`applied`, not `released`) usage rows.
 *
 * Deliberately does not remove the `WC_Order_Item_Fee` itself or touch the
 * order in any way — the order's own historical total (including whatever
 * discount was actually offered at the time) stays exactly as it was,
 * matching this codebase's "receipt/order data is authoritative, never
 * retroactively rewritten" discipline. Only the CAMPAIGN's own usage
 * bookkeeping changes.
 */
final class UsageReleaseListener {

	public function register(): void {
		add_action( 'woocommerce_order_status_cancelled', [ $this, 'on_order_dead' ] );
		add_action( 'woocommerce_order_status_failed', [ $this, 'on_order_dead' ] );
		add_action( 'woocommerce_order_status_refunded', [ $this, 'on_order_dead' ] );
	}

	public function on_order_dead( int $order_id ): void {
		( new CampaignService() )->release_usage_for_order( $order_id );
	}
}
