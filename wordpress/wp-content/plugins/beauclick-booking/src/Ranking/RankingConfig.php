<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

/**
 * One home for every ranking weight/threshold, mirroring
 * beauclick-loyalty\EarningRules' precedent from V2.0 Step 1: a single,
 * clearly-documented, provisional policy class rather than magic numbers
 * scattered across RankingScorer/SignalCollector. Every value here is a
 * genuine business-policy choice, not a technical constant — change it here,
 * nowhere else, and no code needs to change shape to absorb a new weight.
 *
 * All weights sum to 1.0 (asserted by RankingScorerTest). Values are
 * deliberately simple and explainable (a weighted sum of normalized 0-1
 * signals, not a trained model) per the architecture doc's own §4.9
 * conclusion: "a weighted-sum of normalized signals is a reasonable v1, not
 * a machine-learning system."
 */
final class RankingConfig {

	/** Bayesian/shrinkage rating: how many "phantom average reviews" pull a small sample toward the platform mean. Higher = new/low-volume providers move less on a single review. */
	public const RATING_CONFIDENCE_C = 10.0;

	/** Fallback platform-average rating used only when literally no provider anywhere has a review yet (cold-boot state). */
	public const RATING_FALLBACK_MEAN = 4.0;

	/** Below this many completed+cancelled bookings, completion_rate is treated as neutral (0.5) rather than penalizing/rewarding on a too-small sample. */
	public const COMPLETION_RATE_MIN_SAMPLE = 3;

	/** Below this many profile views in the lookback window, the view->booking conversion signal is treated as neutral rather than computed on noise. */
	public const CONVERSION_MIN_VIEWS = 10;

	/** Response time (seconds) at or below this is scored 1.0 (full credit); above RESPONSE_TIME_FLOOR_SECONDS decays to 0. */
	public const RESPONSE_TIME_CEIL_SECONDS  = 10 * MINUTE_IN_SECONDS;
	public const RESPONSE_TIME_FLOOR_SECONDS = 24 * HOUR_IN_SECONDS;

	/** Rolling window for time-sensitive signals (response time, profile views, recent-activity count). */
	public const LOOKBACK_DAYS = 90;

	/** Narrower window specifically for the "recent activity" freshness signal — 90 days is too coarse to reward genuinely current activity. */
	public const RECENT_ACTIVITY_DAYS = 30;

	/** Recent-activity event count that already earns full credit (1.0) — a log-scale cap so one hyperactive provider can't dominate this signal. */
	public const RECENT_ACTIVITY_SATURATION = 20;

	/** Signal weights — must sum to 1.0. */
	public const WEIGHT_RATING_CONFIDENCE  = 0.32;
	public const WEIGHT_VERIFIED           = 0.10;
	public const WEIGHT_COMPLETION_RATE    = 0.18;
	public const WEIGHT_RESPONSE_SPEED     = 0.12;
	public const WEIGHT_PROFILE_COMPLETE   = 0.12;
	public const WEIGHT_RECENT_ACTIVITY    = 0.10;
	public const WEIGHT_CONVERSION         = 0.06;

	/**
	 * Cold-start blending (see RankingScorer::score() for the formula): a
	 * provider's own weighted signal score is blended with this neutral
	 * baseline in proportion to how much real evidence exists yet, so a
	 * brand-new professional starts comfortably mid-pack — not at zero
	 * (which a weighted average of all-neutral-default signals would
	 * otherwise produce) and not pinned exactly level with an established
	 * high performer either.
	 */
	public const COLD_START_BASELINE   = 0.55;
	public const COLD_START_EVIDENCE_K = 5.0;

	/** Signal-key thresholds for RankingExplainer — a key is only ever recorded/shown if the raw signal genuinely crosses this bar. */
	public const HIGH_RATING_MIN_AVG    = 4.5;
	public const HIGH_RATING_MIN_COUNT  = 5;
	public const RELIABLE_MIN_RATE      = 0.9;
	public const RELIABLE_MIN_SAMPLE    = 5;
	public const COMPLETE_PROFILE_MIN   = 0.99; // Effectively "all four profile-completeness components present."
}
