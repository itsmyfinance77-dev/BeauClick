<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Membership;

use BeauClick\Loyalty\Tiers\TierService;

/**
 * V2.1 Step 9 — the one bridge between tiers and membership: when a
 * customer's lifetime points newly qualify them for a tier, and that tier
 * has a linked membership plan (`wp_bc_membership_plans.tier_id`), the
 * matching membership is auto-activated. Deliberately one-directional and
 * additive only -- this NEVER auto-cancels or downgrades a membership a
 * customer already holds (e.g. one a different, unlinked plan, or one an
 * admin granted manually), matching the task's own "loyalty tiers and
 * membership are related but separate concepts" instruction. Reacts to
 * `beauclick/loyalty/points_awarded`, fired once per real award from
 * EarningRules -- never runs on every page load, only when points actually
 * changed.
 */
final class TierMembershipSync {

	public function register(): void {
		add_action( 'beauclick/loyalty/points_awarded', [ $this, 'sync' ] );
	}

	public function sync( int $user_id ): void {
		$tier_service = new TierService();
		$progress     = $tier_service->progress_for_user( $user_id );
		$tier         = $progress['currentTier'];
		if ( ! $tier ) {
			return;
		}

		global $wpdb;
		$plan_id = $wpdb->get_var(
			$wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_membership_plans WHERE tier_id = %d AND is_active = 1 LIMIT 1", $tier['id'] ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( ! $plan_id ) {
			return;
		}

		$membership_service = new MembershipService();
		$existing            = $membership_service->for_user( $user_id );
		if ( $existing && MembershipService::STATUS_ACTIVE === $existing['status'] && $existing['planId'] === (int) $plan_id ) {
			return; // Already exactly this plan, active -- nothing to do.
		}
		if ( $existing && MembershipService::STATUS_ACTIVE === $existing['status'] && 'tier_qualification' !== $existing['activationSource'] ) {
			return; // A different, non-tier-qualification membership is active (manual grant or a distinct paid plan) -- never overwrite it silently.
		}

		$membership_service->activate( $user_id, (int) $plan_id, 'tier_qualification' );
	}
}
