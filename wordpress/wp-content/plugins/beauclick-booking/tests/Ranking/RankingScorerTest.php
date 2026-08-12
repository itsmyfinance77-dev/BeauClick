<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests\Ranking;

use BeauClick\Booking\Ranking\RankingScorer;
use BeauClick\Booking\Ranking\RankingSignals;
use WP_UnitTestCase;

/**
 * Pure unit tests against hand-built RankingSignals -- no database, no WP
 * post creation, so every scenario the task explicitly calls out (extreme
 * review counts, missing data, zero everything) is cheap to construct
 * exactly, not approximated through real seed data.
 */
final class RankingScorerTest extends WP_UnitTestCase {

	private function signals( array $overrides = [] ): RankingSignals {
		$defaults = [
			'ratingAvg'            => 0.0,
			'reviewCount'          => 0,
			'verified'             => false,
			'completedBookings'    => 0,
			'cancelledBookings'    => 0,
			'totalBookingsCreated' => 0,
			'avgResponseSeconds'   => null,
			'profileViews'         => 0,
			'profileCompleteness'  => 0.0,
			'recentActivityCount'  => 0,
		];
		$args = array_merge( $defaults, $overrides );
		return new RankingSignals( ...$args );
	}

	public function test_scoring_is_deterministic_for_identical_input(): void {
		$scorer  = new RankingScorer();
		$signals = $this->signals( [ 'ratingAvg' => 4.5, 'reviewCount' => 20, 'verified' => true ] );

		$first  = $scorer->score( $signals, 4.0 );
		$second = $scorer->score( $signals, 4.0 );

		$this->assertSame( $first->value, $second->value, 'The exact same signals must always produce the exact same score.' );
		$this->assertSame( $first->signalKeys, $second->signalKeys );
	}

	/**
	 * The task's own worked example: 5.0 from 1 review must NOT outrank 4.8
	 * from 250 reviews. Bayesian/shrinkage rating solves this directly.
	 * Every OTHER signal is held identical and realistic (not the all-zero
	 * default) on both sides so this isolates the rating dimension alone --
	 * otherwise the cold-start blend (which exists to protect a genuinely
	 * new provider on EVERY signal, not just rating) would confound the
	 * comparison, since the 1-review case would also get blended rescue on
	 * unrelated signals the 250-review case, past the evidence threshold,
	 * no longer receives.
	 */
	public function test_a_single_perfect_review_does_not_outrank_a_large_base_of_strong_reviews(): void {
		$scorer = new RankingScorer();
		$base   = [ 'verified' => true, 'completedBookings' => 20, 'cancelledBookings' => 1, 'avgResponseSeconds' => 300, 'profileCompleteness' => 1.0, 'recentActivityCount' => 10 ];

		$one_review   = $this->signals( $base + [ 'ratingAvg' => 5.0, 'reviewCount' => 1 ] );
		$many_reviews = $this->signals( $base + [ 'ratingAvg' => 4.8, 'reviewCount' => 250 ] );

		$score_one  = $scorer->score( $one_review, 4.0 )->value;
		$score_many = $scorer->score( $many_reviews, 4.0 )->value;

		$this->assertGreaterThan( $score_one, $score_many, 'A large base of strong reviews must outrank one perfect review with almost no volume.' );
	}

	public function test_review_volume_increases_confidence_toward_the_raw_rating(): void {
		$scorer = new RankingScorer();
		$base   = [ 'verified' => true, 'completedBookings' => 20, 'cancelledBookings' => 1, 'avgResponseSeconds' => 300, 'profileCompleteness' => 1.0, 'recentActivityCount' => 10 ];

		$low_volume  = $this->signals( $base + [ 'ratingAvg' => 4.5, 'reviewCount' => 2 ] );
		$high_volume = $this->signals( $base + [ 'ratingAvg' => 4.5, 'reviewCount' => 500 ] );

		// Same raw rating, same everything else -- but a low-volume 4.5 is
		// pulled toward the platform mean (assumed 4.0 here, below 4.5), so
		// it must score LOWER than a high-volume 4.5, which is barely
		// shrunk at all.
		$score_low  = $scorer->score( $low_volume, 4.0 )->value;
		$score_high = $scorer->score( $high_volume, 4.0 )->value;

		$this->assertLessThan( $score_high, $score_low, 'A rating backed by very few reviews must be pulled toward the platform mean more than one backed by many.' );
	}

	public function test_an_extremely_high_review_count_converges_toward_the_raw_rating(): void {
		$scorer = new RankingScorer();
		$huge   = $this->signals( [ 'ratingAvg' => 4.9, 'reviewCount' => 100000, 'verified' => true, 'completedBookings' => 1000, 'avgResponseSeconds' => 120, 'profileCompleteness' => 1.0, 'recentActivityCount' => 20 ] );

		$score = $scorer->score( $huge, 3.0 )->value;

		// At 100,000 reviews the shrinkage constant (10) is negligible --
		// the rating-confidence component should be essentially the raw
		// 4.9/5.0 = 0.98, not meaningfully pulled toward the 3.0 mean. With
		// every other signal also maxed out realistically, the composite
		// score should land near the top of the 0-100 range.
		$this->assertGreaterThan( 90.0, $score, 'An enormous, genuinely excellent review base (with strong signals elsewhere) must score near the top of the range, not be dragged down by shrinkage toward the mean.' );
	}

	public function test_a_brand_new_professional_with_zero_data_scores_near_the_cold_start_baseline_not_zero(): void {
		$scorer = new RankingScorer();
		$new_pro = $this->signals(); // everything zero/null/false

		$score = $scorer->score( $new_pro, 4.0 )->value;

		$this->assertGreaterThan( 40.0, $score, 'A brand-new professional with no data yet must not be buried at or near zero.' );
		$this->assertLessThan( 65.0, $score, 'A brand-new professional must not be scored as if they were an established high performer either.' );
	}

	public function test_a_professional_with_real_strong_evidence_outscores_the_cold_start_baseline(): void {
		$scorer = new RankingScorer();
		$strong = $this->signals(
			[
				'ratingAvg'            => 4.9,
				'reviewCount'          => 50,
				'verified'             => true,
				'completedBookings'    => 40,
				'cancelledBookings'    => 1,
				'avgResponseSeconds'   => 120,
				'profileCompleteness'  => 1.0,
				'recentActivityCount'  => 15,
			]
		);
		$new_pro = $this->signals();

		$score_strong = $scorer->score( $strong, 4.0 )->value;
		$score_new    = $scorer->score( $new_pro, 4.0 )->value;

		$this->assertGreaterThan( $score_new, $score_strong, 'Real, strong evidence must score meaningfully higher than the cold-start baseline -- fairness for new professionals must not become "everyone is ranked equally".' );
	}

	public function test_verified_status_increases_score_all_else_equal(): void {
		$scorer = new RankingScorer();
		$base   = [ 'ratingAvg' => 4.0, 'reviewCount' => 10, 'completedBookings' => 10 ];

		$verified   = $scorer->score( $this->signals( $base + [ 'verified' => true ] ), 4.0 )->value;
		$unverified = $scorer->score( $this->signals( $base + [ 'verified' => false ] ), 4.0 )->value;

		$this->assertGreaterThan( $unverified, $verified );
	}

	public function test_a_high_cancellation_rate_lowers_score_versus_a_reliable_provider(): void {
		$scorer = new RankingScorer();
		$base   = [ 'ratingAvg' => 4.5, 'reviewCount' => 10 ];

		$reliable = $scorer->score( $this->signals( $base + [ 'completedBookings' => 19, 'cancelledBookings' => 1 ] ), 4.0 )->value;
		$flaky    = $scorer->score( $this->signals( $base + [ 'completedBookings' => 1, 'cancelledBookings' => 19 ] ), 4.0 )->value;

		$this->assertGreaterThan( $flaky, $reliable, 'A provider who mostly cancels must score lower than one who mostly completes, all else equal.' );
	}

	public function test_a_provider_with_too_few_bookings_to_judge_reliability_is_neutral_not_penalized(): void {
		$scorer = new RankingScorer();
		// Only 1 cancelled booking ever, below COMPLETION_RATE_MIN_SAMPLE (3)
		// -- must not be scored as if they have a 0% completion rate.
		$tiny_sample = $this->signals( [ 'ratingAvg' => 4.0, 'reviewCount' => 5, 'cancelledBookings' => 1 ] );
		$no_bookings = $this->signals( [ 'ratingAvg' => 4.0, 'reviewCount' => 5 ] );

		$score_tiny = $scorer->score( $tiny_sample, 4.0 )->value;
		$score_none = $scorer->score( $no_bookings, 4.0 )->value;

		$this->assertEqualsWithDelta( $score_none, $score_tiny, 0.01, 'A single cancellation with no completions must be treated as an insufficient sample, not a 0% completion rate.' );
	}

	public function test_faster_response_time_scores_higher_than_slower(): void {
		$scorer = new RankingScorer();
		$base   = [ 'ratingAvg' => 4.0, 'reviewCount' => 10 ];

		$fast = $scorer->score( $this->signals( $base + [ 'avgResponseSeconds' => 60 ] ), 4.0 )->value;
		$slow = $scorer->score( $this->signals( $base + [ 'avgResponseSeconds' => 23 * HOUR_IN_SECONDS ] ), 4.0 )->value;

		$this->assertGreaterThan( $slow, $fast );
	}

	public function test_missing_response_time_data_is_neutral_not_penalized(): void {
		$scorer = new RankingScorer();
		$base   = [ 'ratingAvg' => 4.0, 'reviewCount' => 10 ];

		$missing = $scorer->score( $this->signals( $base + [ 'avgResponseSeconds' => null ] ), 4.0 )->value;
		$slowest = $scorer->score( $this->signals( $base + [ 'avgResponseSeconds' => 30 * DAY_IN_SECONDS ] ), 4.0 )->value;

		$this->assertGreaterThan( $slowest, $missing, 'No response-time data yet (a provider with no confirmed bookings) must not be scored as if they were maximally slow.' );
	}

	public function test_higher_profile_completeness_scores_higher(): void {
		$scorer = new RankingScorer();
		$base   = [ 'ratingAvg' => 4.0, 'reviewCount' => 10 ];

		$complete   = $scorer->score( $this->signals( $base + [ 'profileCompleteness' => 1.0 ] ), 4.0 )->value;
		$incomplete = $scorer->score( $this->signals( $base + [ 'profileCompleteness' => 0.0 ] ), 4.0 )->value;

		$this->assertGreaterThan( $incomplete, $complete );
	}

	public function test_too_few_profile_views_makes_conversion_neutral_not_a_noisy_ratio(): void {
		$scorer = new RankingScorer();
		// 1 view, 1 booking = a "perfect" 100% ratio on a meaningless sample
		// size -- must not be treated as real signal.
		$noisy    = $this->signals( [ 'ratingAvg' => 4.0, 'reviewCount' => 10, 'profileViews' => 1, 'totalBookingsCreated' => 1 ] );
		$no_views = $this->signals( [ 'ratingAvg' => 4.0, 'reviewCount' => 10 ] );

		$score_noisy = $scorer->score( $noisy, 4.0 )->value;
		$score_none  = $scorer->score( $no_views, 4.0 )->value;

		$this->assertEqualsWithDelta( $score_none, $score_noisy, 0.01, 'A 1-view/1-booking sample must be treated as insufficient data, not a genuine 100% conversion signal.' );
	}

	public function test_extreme_and_zero_values_never_produce_nan_or_negative_scores(): void {
		$scorer = new RankingScorer();

		$zero    = $scorer->score( $this->signals(), 0.0 )->value;
		$extreme = $scorer->score(
			$this->signals(
				[
					'ratingAvg'            => 5.0,
					'reviewCount'          => PHP_INT_MAX >> 32,
					'completedBookings'    => 999999,
					'cancelledBookings'    => 999999,
					'profileViews'         => 999999,
					'totalBookingsCreated' => 999999,
					'recentActivityCount'  => 999999,
				]
			),
			4.0
		)->value;

		foreach ( [ $zero, $extreme ] as $value ) {
			$this->assertIsFloat( $value );
			$this->assertFalse( is_nan( $value ) );
			$this->assertGreaterThanOrEqual( 0.0, $value );
			$this->assertLessThanOrEqual( 100.0, $value );
		}
	}

	public function test_signal_keys_only_include_genuinely_earned_reasons(): void {
		$scorer = new RankingScorer();
		$signals = $this->signals(
			[
				'ratingAvg'           => 3.0, // below HIGH_RATING_MIN_AVG
				'reviewCount'         => 10,
				'verified'            => false,
				'avgResponseSeconds'  => 5 * DAY_IN_SECONDS, // slow
				'profileCompleteness' => 0.5, // below COMPLETE_PROFILE_MIN
				'recentActivityCount' => 0,
			]
		);

		$keys = $scorer->score( $signals, 4.0 )->signalKeys;

		$this->assertSame( [], $keys, 'None of these signals genuinely earned an explanation -- the key list must be empty, not padded with unearned reasons.' );
	}

	public function test_signal_keys_include_verified_and_high_rating_when_genuinely_earned(): void {
		$scorer  = new RankingScorer();
		$signals = $this->signals( [ 'ratingAvg' => 4.9, 'reviewCount' => 20, 'verified' => true ] );

		$keys = $scorer->score( $signals, 4.0 )->signalKeys;

		$this->assertContains( 'verified', $keys );
		$this->assertContains( 'high_rating', $keys );
	}
}
