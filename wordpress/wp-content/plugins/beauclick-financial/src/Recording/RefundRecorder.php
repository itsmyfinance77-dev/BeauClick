<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Recording;

use BeauClick\Financial\LedgerService;

/**
 * Independently hooks WooCommerce's own `woocommerce_order_refunded` action
 * -- fired by the CORE `wc_create_refund()` function itself
 * (`wc-order-functions.php`), confirmed by reading that function directly
 * rather than assuming -- for EVERY refund in this codebase, regardless of
 * which feature triggered it: the pre-existing
 * `Payments\Plugin::handle_paid_but_unconfirmable_booking()` edge case, and
 * the new cancellation-refund path this same Step wires into
 * `Payments\Plugin::on_booking_cancelled()`. This class never needs to know
 * either exists -- it only reacts to the real, authoritative fact that
 * WooCommerce itself already recorded a refund.
 */
final class RefundRecorder {

	public function register(): void {
		add_action( 'woocommerce_order_refunded', [ $this, 'on_order_refunded' ], 10, 2 );
	}

	public function on_order_refunded( int $order_id, int $refund_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order || ! (int) $order->get_meta( '_bc_booking_id' ) ) {
			return; // Not a booking order -- out of this ledger's scope (see PaymentRecorder's own docblock).
		}

		$refund = wc_get_order( $refund_id );
		if ( ! $refund instanceof \WC_Order_Refund ) {
			return;
		}

		$refund_amount = (int) round( abs( (float) $refund->get_amount() ) );

		( new LedgerService() )->record_refund( $order_id, $refund_id, $refund_amount );
	}
}
