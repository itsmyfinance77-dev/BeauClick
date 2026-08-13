<?php
declare( strict_types=1 );

namespace BeauClick\Referral;

/**
 * Provisional engineering defaults, NOT final business policy —
 * `NEEDS_BUSINESS_DECISION`, per the Product Gap Register's own
 * "referral reward structure" entry (open since V2.1 Step 9's loyalty work
 * first deferred Referral out of its own scope). Deliberately simple, flat
 * numbers in the same style/scale as beauclick-loyalty's own
 * EarningRules::POINTS_* provisional constants — not proportional to any
 * order value, not a final reward design. Both filterable so the business's
 * real decision can be applied without a deploy once made.
 */
final class ReferralConfig {

	public const DEFAULT_REFERRER_REWARD_POINTS = 50;
	public const DEFAULT_REFEREE_REWARD_POINTS  = 50;

	public static function referrer_reward_points(): int {
		return (int) apply_filters( 'beauclick/referral/referrer_reward_points', self::DEFAULT_REFERRER_REWARD_POINTS );
	}

	public static function referee_reward_points(): int {
		return (int) apply_filters( 'beauclick/referral/referee_reward_points', self::DEFAULT_REFEREE_REWARD_POINTS );
	}
}
