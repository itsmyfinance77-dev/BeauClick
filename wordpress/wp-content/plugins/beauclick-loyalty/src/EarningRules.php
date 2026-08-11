<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty;

/**
 * V2.0 Step 1 — activates the previously-dormant LoyaltyLedger by
 * subscribing to hook seams the domain plugins fire (or now fire, for this
 * purpose) for their own lifecycle events, rather than beauclick-loyalty
 * reaching into beauclick-booking/-reviews/-payments directly. Matches the
 * same cross-plugin communication convention already used everywhere else
 * in this codebase (beauclick/booking/after_create,
 * beauclick/chat/message_sent).
 *
 * Point values below are a provisional placeholder policy, not a real
 * business rule — V1 never defined one (LoyaltyLedger's own docblock says
 * so explicitly: "no rule decides who earns points for what yet"). These
 * are deliberately simple, flat, round numbers rather than anything
 * proportional to order value or service price, centralized here so
 * they're trivial to replace once the business defines real point
 * economics — see docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md's V2.0 Step 1
 * implementation note for the full reasoning.
 *
 * Every award call is server-side and reacts only to a trusted domain
 * operation that has already happened (a booking actually transitioned to
 * completed, a review actually got inserted, a WooCommerce order actually
 * paid) — none of these hooks fire from client-controlled input a
 * professional/business/customer could manipulate to award themselves
 * points directly.
 */
final class EarningRules {

	public const POINTS_BOOKING_COMPLETED    = 10;
	public const POINTS_REVIEW_SUBMITTED     = 5;
	public const POINTS_SHOP_ORDER_COMPLETED = 10;

	public function register(): void {
		add_action( 'beauclick/booking/completed', [ $this, 'on_booking_completed' ] );
		add_action( 'beauclick/reviews/submitted', [ $this, 'on_review_submitted' ], 10, 3 );
		add_action( 'beauclick/payments/shop_order_completed', [ $this, 'on_shop_order_completed' ], 10, 2 );
	}

	/**
	 * BookingService::complete_booking() only fires this hook when its own
	 * atomic status transition actually succeeded (confirmed -> completed),
	 * which by construction happens at most once per booking — a second
	 * call to complete_booking() finds the row already 'completed' and
	 * never re-fires the hook. The has_awarded() guard below is defense in
	 * depth on top of that, not the only thing preventing a double award.
	 */
	public function on_booking_completed( int $booking_id ): void {
		global $wpdb;
		$customer_id = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT customer_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( ! $customer_id ) {
			return;
		}
		$this->award_once( $customer_id, self::POINTS_BOOKING_COMPLETED, 'booking_completed', 'booking', $booking_id );
	}

	/**
	 * ReviewService::create() only fires this hook after a genuine insert —
	 * a booking already reviewed is rejected before that point (both by an
	 * application check and a UNIQUE key on bc_reviews.booking_id), so this
	 * can't fire twice for the same booking either.
	 */
	public function on_review_submitted( int $review_id, int $author_id, int $booking_id ): void {
		if ( ! $author_id ) {
			return;
		}
		$this->award_once( $author_id, self::POINTS_REVIEW_SUBMITTED, 'review_submitted', 'review', $review_id );
	}

	/**
	 * Fired only for a NON-booking WooCommerce order (a real Shop/B2B
	 * product purchase) — beauclick-payments\Plugin deliberately does not
	 * fire this for a booking's own linked order, since that payment is
	 * already what unlocks booking_completed's award later; treating "paid
	 * for a booking" and "the service was actually delivered" as the same
	 * reward-worthy moment would double-count one real transaction.
	 * woocommerce_payment_complete can in principle re-fire for the same
	 * order under some gateway/webhook-retry conditions, so — unlike the
	 * two hooks above — this one has no atomic guard of its own upstream,
	 * making the has_awarded()/UNIQUE-index guarantee the only thing
	 * preventing a double award here.
	 */
	public function on_shop_order_completed( int $order_id, int $customer_id ): void {
		if ( ! $customer_id ) {
			return; // Guest checkout — no account to credit.
		}
		$this->award_once( $customer_id, self::POINTS_SHOP_ORDER_COMPLETED, 'order_completed', 'order', $order_id );
	}

	private function award_once( int $user_id, int $points, string $reason, string $reference_type, int $reference_id ): void {
		$ledger = beauclick_loyalty()->ledger();
		if ( $ledger->has_awarded( $reference_type, $reference_id, $reason ) ) {
			return;
		}
		$ledger->award( $user_id, $points, $reason, $reference_type, $reference_id );
	}
}
