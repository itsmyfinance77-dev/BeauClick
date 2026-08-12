<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

/**
 * Raw, pre-normalization inputs for one provider — everything
 * SignalCollector gathered, before RankingScorer turns it into a score.
 * Deliberately dumb/flat: this is a data-transfer object, not a place for
 * scoring logic, so RankingScorer can be unit-tested against hand-built
 * instances without touching the database at all.
 */
final class RankingSignals {

	public function __construct(
		public readonly float $ratingAvg,
		public readonly int $reviewCount,
		public readonly bool $verified,
		public readonly int $completedBookings,
		public readonly int $cancelledBookings,
		public readonly int $totalBookingsCreated, // windowed (RankingConfig::LOOKBACK_DAYS) -- the conversion signal's numerator; distinct from completedBookings so completion_rate and conversion never share one number for two different meanings.
		public readonly ?int $avgResponseSeconds,
		public readonly int $profileViews, // windowed, same lookback
		public readonly float $profileCompleteness, // 0.0-1.0
		public readonly int $recentActivityCount
	) {
	}
}
