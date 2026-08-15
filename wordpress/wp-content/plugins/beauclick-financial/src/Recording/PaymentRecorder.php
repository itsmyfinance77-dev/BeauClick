<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Recording;

use BeauClick\Financial\LedgerService;

/**
 * Independently hooks the SAME `woocommerce_payment_complete` action
 * `beauclick-payments\Plugin::on_payment_complete()` already listens to —
 * WordPress supports multiple independent callbacks per hook, and this
 * class never needs to know that listener exists, matching this codebase's
 * one-way, hook-based cross-plugin convention (the same pattern V2.3 Step
 * 17's `CampaignDiscount`/`UsageReleaseListener` already established).
 *
 * Scope decision (see the migration's own docblock): only orders carrying
 * `_bc_booking_id` meta get ledger entries — a Shop/B2B purchase has no
 * professional/business party to split revenue with, so it's deliberately
 * skipped here, not recorded as some fictional "platform-only" receivable.
 */
final class PaymentRecorder {

	public function register(): void {
		add_action( 'woocommerce_payment_complete', [ $this, 'on_payment_complete' ] );
	}

	public function on_payment_complete( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}

		$booking_id = (int) $order->get_meta( '_bc_booking_id' );
		if ( ! $booking_id ) {
			return; // Not a booking order -- a Shop/B2B purchase, out of this ledger's scope.
		}

		global $wpdb;
		$provider_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT provider_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( ! $provider_id ) {
			return;
		}

		$party_type = $this->party_type_for_provider( $provider_id );
		if ( ! $party_type ) {
			return;
		}

		$net_amount = (int) round( (float) $order->get_total() );

		( new LedgerService() )->record_payment( $order_id, $booking_id, $party_type, $provider_id, $net_amount );
	}

	/**
	 * A booking's `provider_id` is a `bc_professional` OR `bc_business` CPT
	 * post id, never a WP user id (`ProviderLookup`'s own established
	 * convention) -- the post TYPE is what determines which party this
	 * order's receivable belongs to.
	 */
	private function party_type_for_provider( int $provider_id ): ?string {
		return match ( get_post_type( $provider_id ) ) {
			'bc_professional' => LedgerService::PARTY_PROFESSIONAL,
			'bc_business'     => LedgerService::PARTY_BUSINESS,
			default           => null,
		};
	}
}
