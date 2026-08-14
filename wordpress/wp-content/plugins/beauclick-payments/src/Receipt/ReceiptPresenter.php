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
		$items = [];
		foreach ( $order->get_items() as $item ) {
			$items[] = [
				'name'     => $item->get_name(),
				'quantity' => $item->get_quantity(),
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
