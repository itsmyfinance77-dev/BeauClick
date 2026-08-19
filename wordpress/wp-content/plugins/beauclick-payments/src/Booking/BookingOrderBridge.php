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

	/**
	 * V2.4 Step 26 (part 2), GAP-03. The only real call site (`Plugin::
	 * attach_order_to_booking_result()`, fired once per `beauclick/booking/
	 * after_create`) cannot currently be double-invoked for the same booking
	 * through the primary flow -- slot-claiming already makes a resubmitted
	 * create-booking request fail before a second booking row ever exists.
	 * This guard is the same defense-in-depth discipline `LedgerService`/
	 * `CampaignService` already apply to every write in this codebase: a
	 * retried call, a future recovery/retry tool, or a hook re-fire must
	 * return the SAME order rather than silently creating a second one and
	 * overwriting `wc_order_id` (which would orphan the first order).
	 */
	public function create_order_for_booking( int $booking_id, int $customer_id, \WC_Product $product ): \WC_Order {
		global $wpdb;

		$existing_order_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT wc_order_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $existing_order_id ) {
			$existing_order = wc_get_order( $existing_order_id );
			if ( $existing_order instanceof \WC_Order ) {
				return $existing_order;
			}
		}

		$order = wc_create_order( [ 'customer_id' => $customer_id ] );
		$order->add_product( $product, 1 );

		$order->update_meta_data( '_bc_booking_id', $booking_id );
		$order->calculate_totals();
		$order->set_status( 'pending' );
		$order->save();

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
