<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Listeners;

use BeauClick\Referral\ReferralService;

/**
 * Two qualifying paths, deliberately mirroring beauclick-loyalty's own
 * EarningRules hook pair exactly (`beauclick/booking/completed` and
 * `beauclick/payments/shop_order_completed`) rather than re-hooking
 * WooCommerce directly — "first real completed booking OR first real
 * completed shop/B2B order, whichever happens first" is this step's
 * qualifying-action definition (task's own §16: "do not assume
 * registration alone should trigger a reward"). Both hooks only ever fire
 * for a genuine, already-happened domain event — never client-controlled
 * input a referee could manipulate to self-qualify.
 *
 * ReferralService::qualify() is itself idempotent (only acts on a
 * 'pending' row, atomically), so no additional guard is needed here even
 * though a referee could in principle fire both hooks over their lifetime.
 */
final class QualificationListener {

	public function register(): void {
		add_action( 'beauclick/booking/completed', [ $this, 'on_booking_completed' ] );
		add_action( 'beauclick/payments/shop_order_completed', [ $this, 'on_shop_order_completed' ], 10, 2 );
	}

	public function on_booking_completed( int $booking_id ): void {
		global $wpdb;
		$customer_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT customer_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( ! $customer_id ) {
			return;
		}
		( new ReferralService() )->qualify( $customer_id );
	}

	public function on_shop_order_completed( int $order_id, int $customer_id ): void {
		if ( ! $customer_id ) {
			return; // Guest checkout -- no account to qualify.
		}
		( new ReferralService() )->qualify( $customer_id );
	}
}
