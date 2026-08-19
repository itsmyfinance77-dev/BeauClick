<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Pricing;

use BeauClick\Campaigns\CampaignService;
use BeauClick\Campaigns\EligibilityResolver;

/**
 * V2.3 Step 17's Pricing Orchestration decision, implemented: a campaign
 * discount, like beauclick-loyalty's own `MembershipDiscount`, is applied as
 * a single itemized negative `WC_Order_Item_Fee` directly on the booking's
 * own WooCommerce order — never a `woocommerce_before_calculate_totals`
 * cart filter, never touching WooCommerce's own (unused) coupon system,
 * never touching a Shop/B2B-wholesale cart purchase or a B2B quote-accept
 * order (both deliberately out of Phase 1 scope — see this class's own
 * "B2B compatibility" note below). Booking orders never touch the
 * WooCommerce cart at all (`BookingOrderBridge::create_order_for_booking()`
 * calls `wc_create_order()` + `add_product()` directly), which is exactly
 * what makes this integration structurally unable to collide with
 * `beauclick-b2b\Pricing\TierPricingEngine`'s own cart filter — the same
 * reasoning `MembershipDiscount`'s own docblock already established.
 *
 * Registered at priority 30 on `beauclick/booking/after_create` — strictly
 * after beauclick-payments' own order-creation callback (priority 10) and
 * beauclick-loyalty's MembershipDiscount (priority 20). "No compounding":
 * this class computes its own discount against the order's own pre-fee
 * SUBTOTAL (never against a total already reduced by Membership's fee), so
 * a 10%-off Membership benefit and a 15%-off Campaign are each exactly
 * 10%/15% of the same base, not 15% of an already-10%-off amount — simpler
 * to reason about and to explain to a customer than compounding percentages
 * would be. The one thing this class DOES look at from the order's current
 * state is its remaining total (subtotal minus whatever Membership already
 * subtracted), used only as a final safety clamp so the two discounts
 * together can never push the order below zero, regardless of how large
 * either one is configured to be.
 *
 * B2B compatibility: `beauclick-b2b\Business\QuoteService::accept()` also
 * creates its order directly via `wc_create_order()` (never the cart, like
 * bookings), but fires no comparable filter hook a listener could subscribe
 * to without modifying beauclick-b2b itself — a real, audited finding
 * (CAMP-02 in `PRODUCT_GAP_REGISTER.md`). Rather than expand this plugin's
 * blast radius into a plugin Phase 1 doesn't need to touch, B2B quote orders
 * are explicitly excluded from Campaign Phase 1 — a documented scope
 * decision (task §12's own "if B2B campaign support is not explicitly
 * required, prefer excluding it"), not an oversight.
 */
final class CampaignDiscount {

	public function register(): void {
		add_filter( 'beauclick/booking/after_create', [ $this, 'apply' ], 30, 2 );
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

		$order = wc_get_order( (int) $result['orderId'] );
		if ( ! $order ) {
			return $result;
		}

		$subtotal = (int) $order->get_subtotal();

		$resolver = new EligibilityResolver();
		$best     = $resolver->best_campaign_for(
			[
				'serviceId'  => $context['service_id'] ?? null,
				'providerId' => (int) $context['provider_id'],
				'customerId' => (int) $context['customer_id'],
				'subtotal'   => $subtotal,
				'bookingId'  => (int) $context['booking_id'],
			]
		);

		if ( null === $best ) {
			return $result;
		}

		// Final safety clamp: never let the two discounts together push the
		// order below zero, regardless of Membership's own fee already
		// applied — this is deliberately checked against the order's
		// CURRENT remaining total (subtotal minus whatever Membership
		// already subtracted), not the subtotal EligibilityResolver used to
		// size the discount in isolation, since only this class knows what
		// else has already landed on the order.
		$remaining        = (float) $order->get_total();
		$discount_amount  = min( $best['discountAmount'], (int) round( $remaining ) );
		if ( $discount_amount <= 0 ) {
			return $result;
		}

		$campaign = $best['campaign'];
		$services = new CampaignService();

		// The UNIQUE(booking_id) constraint on wp_bc_campaign_usages still
		// guards against this same booking being recorded twice (a re-fired
		// filter, a retried request). The cap itself (usageLimitTotal /
		// usageLimitPerCustomer) is enforced authoritatively here, inside a
		// transaction, not just by EligibilityResolver's earlier candidate
		// -selection check — see record_usage_within_cap()'s own docblock
		// (V2.4 Step 26 part 2, GAP-04) for why that earlier check alone is
		// racy against concurrent bookings for different booking_ids.
		$recorded = $services->record_usage_within_cap(
			(int) $campaign['id'],
			(int) $context['booking_id'],
			(int) $result['orderId'],
			(int) $context['customer_id'],
			$discount_amount,
			$campaign['usageLimitTotal'],
			$campaign['usageLimitPerCustomer']
		);
		if ( ! $recorded ) {
			return $result;
		}

		$fee = new \WC_Order_Item_Fee();
		/* translators: %s: campaign name */
		$fee->set_name( sprintf( __( 'تخفیف کمپین: %s', 'beauclick-campaigns' ), $campaign['name'] ) );
		$fee->set_amount( (string) ( -$discount_amount ) );
		$fee->set_total( (string) ( -$discount_amount ) );
		$order->add_item( $fee );
		$order->calculate_totals( false ); // false -- do not re-run coupon logic, only re-sum totals including the new fee (same discipline as MembershipDiscount).
		$order->save();

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log(
				'campaign_applied',
				'campaign',
				(int) $campaign['id'],
				(int) $context['customer_id'],
				[
					'bookingId'      => (int) $context['booking_id'],
					'orderId'        => (int) $result['orderId'],
					'discountAmount' => $discount_amount,
					'discountType'   => $campaign['discountType'],
				]
			);
		}

		return $result;
	}
}
