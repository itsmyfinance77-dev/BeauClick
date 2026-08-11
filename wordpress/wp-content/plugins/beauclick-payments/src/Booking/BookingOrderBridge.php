<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Booking;

/**
 * The one place a booking becomes money. The order line item is a real
 * WooCommerce product (via Product\ServiceProductSync), not an ad-hoc fee —
 * that's what makes coupons, tax classes, refunds, and WooCommerce's own
 * product-based reporting all work on booking orders the same way they
 * already work on Shop orders, with zero extra code (architecture doc §14).
 */
final class BookingOrderBridge {

	public function create_order_for_booking( int $booking_id, int $customer_id, \WC_Product $product ): \WC_Order {
		$order = wc_create_order( [ 'customer_id' => $customer_id ] );
		$order->add_product( $product, 1 );

		$order->update_meta_data( '_bc_booking_id', $booking_id );
		$order->calculate_totals();
		$order->set_status( 'pending' );
		$order->save();

		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_bookings',
			[ 'wc_order_id' => $order->get_id(), 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $booking_id ]
		);

		return $order;
	}

	public function find_booking_id_for_order( \WC_Order $order ): ?int {
		$booking_id = $order->get_meta( '_bc_booking_id' );
		return $booking_id ? (int) $booking_id : null;
	}
}
