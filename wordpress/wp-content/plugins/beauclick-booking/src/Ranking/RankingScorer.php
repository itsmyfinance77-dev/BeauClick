<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

/**
 * Pure function: RankingSignals in, RankingScore out. No I/O, no database —
 * everything it needs is already on the DTO, which is what makes this class
 * testable against hand-built signal combinations (zero reviews, extreme
 * review counts, missing response-time data, etc.) without touching WP or
 * MySQL at all.
 *
 * Deterministic and explainable by construction: a weighted sum of
 * independently-normalized 0-1 signals (architecture doc §4.9's own stated
 * bar for a v1 — "not a machine-learning system"), never a black-box score.
 */
final class RankingScorer {

	/**
	 * Rating: Bayesian/shrinkage average (the "IMDB formula"), not a raw
	 * mean — chosen over a Wilson interval because Wilson suits a binary
	 * up/down signal, while this is a 1-5 star average with a count, which
	 * shrinkage handles directly. Concretely solves the exact example the
	 * task was built around: 5.0 from 1 review shrinks to ~4.09 (below) a
	 * 4.8 from 250 reviews, which shrinks to ~4.77 (barely moved) — a
	 * single perfect review can never outrank a large base of strong
	 * reviews, without a hard-coded minimum-review-count cutoff.
	 */
	public function score( RankingSignals $s, ?float $platformMeanRating = null ): RankingScore {
		$mean = $platformMeanRating ?? RankingConfig::RATING_FALLBACK_MEAN;
		$c    = RankingConfig::RATING_CONFIDENCE_C;

		$bayesianRating   = ( $c * $mean + $s->ratingAvg * $s->reviewCount ) / ( $c + $s->reviewCount );
		$ratingConfidence = max( 0.0, min( 1.0, $bayesianRating / 5.0 ) );

		$verified = $s->verified ? 1.0 : 0.0;

		$completionSample = $s->completedBookings + $s->cancelledBookings;
		$completionRate   = $completionSample >= RankingConfig::COMPLETION_RATE_MIN_SAMPLE
			? $s->completedBookings / $completionSample
			: 0.5; // Too little data to judge reliability yet -- neutral, not penalized.

		$responseSpeed = $this->normalize_response_time( $s->avgResponseSeconds );

		$profileComplete = max( 0.0, min( 1.0, $s->profileCompleteness ) );

		// Log-scale, capped -- one hyperactive provider can't dominate this
		// signal, and the curve rewards "some real activity" far more than
		// the last few events toward the cap reward "even more activity".
		$recentActivity = min( 1.0, log( 1 + $s->recentActivityCount ) / log( 1 + RankingConfig::RECENT_ACTIVITY_SATURATION ) );

		$conversion = $s->profileViews >= RankingConfig::CONVERSION_MIN_VIEWS
			? max( 0.0, min( 1.0, $s->totalBookingsCreated / $s->profileViews ) )
			: 0.5; // Too few views to read a meaningful ratio from -- neutral.

		$rawScore =
			RankingConfig::WEIGHT_RATING_CONFIDENCE * $ratingConfidence +
			RankingConfig::WEIGHT_VERIFIED * $verified +
			RankingConfig::WEIGHT_COMPLETION_RATE * $completionRate +
			RankingConfig::WEIGHT_RESPONSE_SPEED * $responseSpeed +
			RankingConfig::WEIGHT_PROFILE_COMPLETE * $profileComplete +
			RankingConfig::WEIGHT_RECENT_ACTIVITY * $recentActivity +
			RankingConfig::WEIGHT_CONVERSION * $conversion;

		// Cold-start blend: a provider with little real evidence yet (few
		// reviews, few bookings) has their raw score pulled toward a neutral
		// baseline instead of being judged fully on signals that are mostly
		// "no data" defaults. A provider with real evidence (evidence >= K)
		// is scored entirely on their own signals -- this only protects the
		// genuinely new, it never caps or discounts an established provider.
		$evidence       = $s->reviewCount + $s->completedBookings;
		$dataConfidence = min( 1.0, $evidence / RankingConfig::COLD_START_EVIDENCE_K );
		$blended        = $dataConfidence * $rawScore + ( 1 - $dataConfidence ) * RankingConfig::COLD_START_BASELINE;

		return new RankingScore( round( $blended * 100, 4 ), $this->signal_keys( $s, $ratingConfidence, $completionRate ) );
	}

	/**
	 * Full credit at or below the ceiling, zero credit at or beyond the
	 * floor, linear in between -- a provider with no booking history yet
	 * (avgResponseSeconds === null) gets neutral credit, not zero, so
	 * response time never becomes a second cold-start penalty on top of the
	 * blend above.
	 */
	private function normalize_response_time( ?int $seconds ): float {
		if ( null === $seconds ) {
			return 0.5;
		}
		if ( $seconds <= RankingConfig::RESPONSE_TIME_CEIL_SECONDS ) {
			return 1.0;
		}
		if ( $seconds >= RankingConfig::RESPONSE_TIME_FLOOR_SECONDS ) {
			return 0.0;
		}
		$range = RankingConfig::RESPONSE_TIME_FLOOR_SECONDS - RankingConfig::RESPONSE_TIME_CEIL_SECONDS;
		return 1.0 - ( $seconds - RankingConfig::RESPONSE_TIME_CEIL_SECONDS ) / $range;
	}

	/** @return array<int, string> */
	private function signal_keys( RankingSignals $s, float $ratingConfidence, float $completionRate ): array {
		$keys = [];

		if ( $s->verified ) {
			$keys[] = 'verified';
		}
		if ( $s->ratingAvg >= RankingConfig::HIGH_RATING_MIN_AVG && $s->reviewCount >= RankingConfig::HIGH_RATING_MIN_COUNT ) {
			$keys[] = 'high_rating';
		}
		if ( null !== $s->avgResponseSeconds && $s->avgResponseSeconds <= RankingConfig::RESPONSE_TIME_CEIL_SECONDS ) {
			$keys[] = 'fast_response';
		}
		if ( $s->recentActivityCount > 0 ) {
			$keys[] = 'recent_activity';
		}
		if ( $s->profileCompleteness >= RankingConfig::COMPLETE_PROFILE_MIN ) {
			$keys[] = 'complete_profile';
		}
		$completionSample = $s->completedBookings + $s->cancelledBookings;
		if ( $completionSample >= RankingConfig::RELIABLE_MIN_SAMPLE && $completionRate >= RankingConfig::RELIABLE_MIN_RATE ) {
			$keys[] = 'reliable';
		}

		return $keys;
	}
}
