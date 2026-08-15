<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Receipt;

use BeauClick\Core\Support\JalaliDate;
use WC_Order;

/**
 * V2.2 Step 15 (COM-04) — a receipt is a read-only presentation over data
 * that already exists and is already authoritative elsewhere: WooCommerce's
 * own order/order-items for every money figure (never re-derived from
 * `bc_service`'s own, separately mutable, current price — see the task's
 * own "receipt values must come from authoritative sources... do not
 * recalculate price independently for display" instruction), and the
 * booking row for appointment context. No new table, no second financial
 * calculation.
 */
final class ReceiptPresenter {

	/** @return array<string, mixed> */
	public function for_order( WC_Order $order ): array {
		/**
		 * V2.3 Step 17 fix: `WC_Order::get_items()` defaults to type
		 * `'line_item'` only — a real, pre-existing gap this step's own live
		 * verification found: `beauclick-loyalty`'s Membership discount fee
		 * (a `WC_Order_Item_Fee`) has never actually appeared in this
		 * receipt's own item list, only silently lowered the final `total`
		 * with no line explaining why. WooCommerce's own checkout/order-
		 * received templates already render fee items correctly (confirmed
		 * live when Membership discount originally shipped) — this
		 * dedicated receipt view was the one place that didn't. Fixed here,
		 * once, for both Membership's existing fee and Campaign's new one
		 * (beauclick-campaigns\Pricing\CampaignDiscount) — task §18's own
		 * "the customer should be able to understand why the price changed"
		 * requirement, and §33's "receipt must remain consistent with the
		 * order."
		 */
		$items = [];
		foreach ( $order->get_items( [ 'line_item', 'fee' ] ) as $item ) {
			$items[] = [
				'name'     => $item->get_name(),
				'quantity' => 'fee' === $item->get_type() ? null : $item->get_quantity(),
				'total'    => (float) $item->get_total(),
			];
		}

		$created = $order->get_date_created();

		return [
			'orderId'         => $order->get_id(),
			'orderNumber'     => $order->get_order_number(),
			'status'          => $order->get_status(),
			'items'           => $items,
			'subtotal'        => (float) $order->get_subtotal(),
			'discountTotal'   => (float) $order->get_discount_total(),
			'total'           => (float) $order->get_total(),
			'currency'        => $order->get_currency(),
			'createdAt'       => $created ? $created->date( 'Y-m-d H:i:s' ) : null,
			'createdAtJalali' => $created ? JalaliDate::format( $created->date( 'Y-m-d H:i:s' ), true ) : null,
			'customerName'    => $order->get_formatted_billing_full_name(),
		];
	}

	/**
	 * @param array<string, mixed> $booking
	 * @return array<string, mixed>
	 */
	public function for_booking( array $booking, ?WC_Order $order ): array {
		$base = $order
			? $this->for_order( $order )
			: [
				'orderId'         => null,
				'orderNumber'     => null,
				'status'          => null,
				'items'           => [],
				'subtotal'        => null,
				'discountTotal'   => null,
				'total'           => null,
				'currency'        => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : null,
				'createdAt'       => null,
				'createdAtJalali' => null,
				'customerName'    => null,
			];

		$provider = get_post( (int) $booking['provider_id'] );
		$service  = $booking['service_id'] ? get_post( (int) $booking['service_id'] ) : null;

		return array_merge(
			$base,
			[
				'bookingId'           => (int) $booking['id'],
				'bookingStatus'       => $booking['status'],
				'providerName'        => $provider ? $provider->post_title : null,
				'serviceName'         => $service ? $service->post_title : null,
				'appointmentAt'       => $booking['slot_start'],
				'appointmentAtJalali' => JalaliDate::format( (string) $booking['slot_start'], true ),
			]
		);
	}
}
