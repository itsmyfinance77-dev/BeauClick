<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Pricing;

use BeauClick\Loyalty\Benefits\BenefitService;

/**
 * V2.1 Step 9's WooCommerce price-hook risk analysis (task §10): B2B's
 * `TierPricingEngine` already owns `woocommerce_before_calculate_totals` —
 * a CART filter. Booking orders, however, never touch the WooCommerce
 * cart at all: `BookingOrderBridge::create_order_for_booking()` calls
 * `wc_create_order()` + `$order->add_product()` directly. That structural
 * fact is what makes this integration safe rather than a second,
 * independent, potentially-stacking cart filter: a membership discount is
 * applied here as a single, itemized, negative `WC_Order_Item_Fee` on the
 * booking's own order, at the one moment that order is created — never a
 * cart hook, never touching a Shop/B2B product, and therefore structurally
 * unable to conflict with `TierPricingEngine` (verified live and by test:
 * B2B cart pricing is untouched by this class, since it only ever runs
 * against `beauclick/booking/after_create`, which no Shop/B2B purchase
 * ever fires).
 *
 * Runs at priority 20 on the same filter `beauclick-payments\Plugin`
 * already uses at its default priority 10 to create the order and attach
 * `orderId` to the result — this class runs strictly after the order
 * exists. The fee amount and the order's own `calculate_totals()` are the
 * SAME call that produces both the price WooCommerce displays and the
 * price it charges, eliminating the exact "displayed price != charged
 * price" bug class this project already found and fixed once in B2B.
 *
 * The discount percentage itself comes from `BenefitService`, entirely
 * admin-configured — this class invents no economics of its own.
 */
final class MembershipDiscount {

	public function register(): void {
		add_filter( 'beauclick/booking/after_create', [ $this, 'apply' ], 20, 2 );
	}

	/**
	 * @param array{booking_id:int, payUrl?:string, orderId?:int} $result
	 * @param array{booking_id:int, customer_id:int, provider_id:int, service_id:?int} $context
	 * @return array{booking_id:int, payUrl?:string, orderId?:int}
	 */
	public function apply( array $result, array $context ): array {
		if ( empty( $result['orderId'] ) || empty( $context['customer_id'] ) ) {
			return $result;
		}

		$percentage = ( new BenefitService() )->discount_percentage_for_user( (int) $context['customer_id'] );
		if ( $percentage <= 0 ) {
			return $result;
		}

		$order = wc_get_order( (int) $result['orderId'] );
		if ( ! $order ) {
			return $result;
		}

		/**
		 * V2.3 Step 17 fix: was `round((float) $order->get_total() * ..., 2)`
		 * — float math with 2-decimal rounding on a Toman-denominated
		 * platform that has no subunit anywhere else (every other price/fee
		 * figure in this codebase is a plain integer). Harmless in isolation
		 * (this class always ran before any other fee existed, so
		 * get_total() === get_subtotal() at the time it fired), but Step 17
		 * introduces a second order-level discount (Campaign) that computes
		 * its own amount against get_subtotal() explicitly (see
		 * beauclick-campaigns\Pricing\CampaignDiscount's own "no compounding"
		 * docblock) — fixed here too so both discounts share the same
		 * integer-Toman, same-base convention rather than one of the two
		 * silently being the odd one out.
		 */
		$discount_amount = (int) round( (int) $order->get_subtotal() * $percentage / 100 );
		if ( $discount_amount <= 0 ) {
			return $result;
		}

		$fee = new \WC_Order_Item_Fee();
		$fee->set_name( __( 'تخفیف عضویت', 'beauclick-loyalty' ) );
		$fee->set_amount( (string) ( -$discount_amount ) );
		$fee->set_total( (string) ( -$discount_amount ) );
		$order->add_item( $fee );
		$order->calculate_totals( false ); // false -- do not re-run coupon logic, only re-sum totals including the new fee.
		$order->save();

		return $result;
	}
}
