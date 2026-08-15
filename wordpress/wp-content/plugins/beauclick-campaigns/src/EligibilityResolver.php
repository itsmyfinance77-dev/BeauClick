<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns;

/**
 * Pure decision logic: given a real booking's context, which (if any) active
 * campaign applies, and for how much. Deliberately NOT a general audience-
 * segmentation engine — the V2.3 discovery audit found no cohort/segment
 * service exists anywhere in this codebase (`MetricsService` is aggregate-
 * only, never a queryable customer-id set), so Phase 1 eligibility is a
 * small, fixed set of direct, cheap, per-order queries against
 * `wp_bc_bookings` (first-booking / returning) rather than anything
 * requiring new segmentation infrastructure.
 *
 * Stacking model: exactly ONE campaign may ever apply to a single booking
 * order (the task's own preferred "simpler model unless there is a strong
 * product requirement for stacking" — no such requirement exists yet). When
 * more than one active campaign is eligible for the same booking, the one
 * producing the LARGEST discount for that specific order wins, ties broken
 * by the lowest campaign id (oldest campaign wins) — deterministic and
 * explainable without needing an admin-configured priority field, which
 * would be one more thing to configure for a Phase 1 that doesn't yet have
 * evidence multiple simultaneously-eligible campaigns is even a real
 * scenario.
 */
final class EligibilityResolver {

	public function __construct( private readonly CampaignService $campaigns = new CampaignService() ) {}

	/**
	 * @param array{serviceId:?int, providerId:int, customerId:int, subtotal:int, bookingId:int, now?:string} $context
	 * @return array{campaign: array<string, mixed>, discountAmount: int}|null
	 */
	public function best_campaign_for( array $context ): ?array {
		$now = $context['now'] ?? current_time( 'mysql' );

		$candidates = $this->campaigns->active_candidates( $context['serviceId'], $context['providerId'], $now );
		if ( ! $candidates ) {
			return null;
		}

		$best = null;
		foreach ( $candidates as $campaign ) {
			if ( ! $this->is_eligible( $campaign, $context ) ) {
				continue;
			}

			$discount_amount = $this->discount_amount_for( $campaign, $context['subtotal'] );
			if ( $discount_amount <= 0 ) {
				continue;
			}

			if ( null === $best || $discount_amount > $best['discountAmount'] ) {
				$best = [ 'campaign' => $campaign, 'discountAmount' => $discount_amount ];
			}
			// Equal-discount tie: candidates already arrive id-ascending
			// (CampaignService::active_candidates()'s own ORDER BY), so the
			// first (lowest-id) campaign to reach a given discount amount is
			// never displaced by a later one producing the identical amount
			// — "oldest campaign wins a tie" falls out of iteration order
			// alone, no extra comparison needed.
		}

		return $best;
	}

	/** @param array<string, mixed> $campaign @param array{serviceId:?int, providerId:int, customerId:int, subtotal:int, bookingId:int} $context */
	private function is_eligible( array $campaign, array $context ): bool {
		if ( null !== $campaign['minOrderValue'] && $context['subtotal'] < $campaign['minOrderValue'] ) {
			return false;
		}

		if ( ! $this->customer_scope_matches( $campaign['customerScope'], $context['customerId'] ) ) {
			return false;
		}

		if ( null !== $campaign['usageLimitTotal'] && $this->campaigns->usage_count( $campaign['id'] ) >= $campaign['usageLimitTotal'] ) {
			return false;
		}

		if ( null !== $campaign['usageLimitPerCustomer'] && $this->campaigns->usage_count( $campaign['id'], $context['customerId'] ) >= $campaign['usageLimitPerCustomer'] ) {
			return false;
		}

		return true;
	}

	private function customer_scope_matches( string $scope, int $customer_id ): bool {
		if ( CampaignService::SCOPE_ALL === $scope ) {
			return true;
		}

		$has_prior_real_booking = $this->has_prior_confirmed_or_completed_booking( $customer_id );

		if ( CampaignService::SCOPE_FIRST_BOOKING === $scope ) {
			return ! $has_prior_real_booking;
		}
		// SCOPE_RETURNING
		return $has_prior_real_booking;
	}

	/**
	 * "Real" prior booking history is deliberately confirmed/completed only
	 * — a customer's own abandoned pending hold or a booking they later
	 * cancelled shouldn't disqualify them from a "first booking" campaign,
	 * and shouldn't count as evidence of being a "returning" customer
	 * either. A provisional, documented engineering interpretation (per the
	 * task's own instruction not to silently invent business policy) — the
	 * exact set of statuses counted here is a business decision the product
	 * owner can revisit; this codebase's own `bc_bookings.status` values
	 * (`pending, confirmed, completed, cancelled, no_show, rescheduled`)
	 * make `confirmed`/`completed` the only two that represent a genuinely
	 * honored booking.
	 */
	private function has_prior_confirmed_or_completed_booking( int $customer_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status IN ('confirmed','completed') LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$customer_id
			)
		);
	}

	/**
	 * Computed independently against the order's own pre-discount subtotal
	 * (never against an already-discounted total) — the Pricing
	 * Orchestration decision this plugin implements (see
	 * `Pricing\CampaignDiscount`'s own docblock): a campaign never
	 * compounds on top of another discount, it always discounts the same
	 * base every other order-level discount does. Clamping to the
	 * customer-facing $subtotal itself (not the order's current total after
	 * any earlier fee) is intentional here too — this method only decides
	 * how big campaign's OWN discount should be in isolation; the final
	 * "never push the order total negative" safety clamp against whatever
	 * is actually left on the order happens in `Pricing\CampaignDiscount`,
	 * which is the only place that knows what else has already been
	 * applied.
	 */
	private function discount_amount_for( array $campaign, int $subtotal ): int {
		if ( CampaignService::TYPE_FIXED === $campaign['discountType'] ) {
			return min( $campaign['discountValue'], $subtotal );
		}

		$amount = (int) round( $subtotal * $campaign['discountValue'] / 100 );
		if ( null !== $campaign['maxDiscountAmount'] ) {
			$amount = min( $amount, $campaign['maxDiscountAmount'] );
		}
		return min( $amount, $subtotal );
	}
}
