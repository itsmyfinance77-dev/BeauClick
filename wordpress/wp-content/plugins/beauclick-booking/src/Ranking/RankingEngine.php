<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

use BeauClick\Marketplace\Search\Indexer;

/**
 * The one orchestration entry point: collect -> score -> write. Everything
 * else in this namespace (SignalCollector, RankingScorer, RankingConfig) is
 * a pure/testable building block this class wires together and persists via
 * beauclick-marketplace\Search\Indexer::update_ranking() -- the same
 * "call the owning plugin's own write method, never raw SQL across the
 * plugin boundary" pattern beauclick-reviews already uses for
 * update_rating().
 *
 * Two trigger paths, both cheap at this project's realistic provider-count
 * scale (a regional/national marketplace, not a global one — low hundreds
 * to low thousands of providers, not millions):
 * - recompute_one(): a handful of indexed, single-provider-scoped queries.
 *   Triggered synchronously whenever something that could move a provider's
 *   score just happened (see Plugin::boot() for the exact hook wiring) --
 *   real-time freshness for the events that matter most.
 * - recompute_all(): a bounded number of GROUP BY aggregate queries (one
 *   per signal type, not per provider) plus one WP-API profile-completeness
 *   lookup per provider. Run on an hourly cron sweep (Cron\RankingScheduler)
 *   as the safety net that catches signals with no discrete "something
 *   happened" trigger of their own (recent-activity decay as time passes
 *   with no new activity; response-time/completion-rate drift as old
 *   bookings age out of the rolling window).
 *
 * Why not batch recompute_all() the way HoldExpiryScheduler batches its own
 * sweep (LIMIT 100 per run)? At today's and near-term provider counts this
 * genuinely isn't needed -- the whole pass is a handful of aggregate queries
 * plus one cheap loop, not a heavy per-row operation. If provider count
 * grows enough for this to show up as a real cron-runtime problem, the fix
 * is the same LIMIT+offset batching pattern HoldExpiryScheduler already
 * established, not a new architecture.
 */
final class RankingEngine {

	public function __construct(
		private readonly SignalCollector $collector = new SignalCollector(),
		private readonly RankingScorer $scorer = new RankingScorer(),
		private readonly Indexer $indexer = new Indexer()
	) {
	}

	public function recompute_one( int $providerId, string $providerType ): void {
		$signals = $this->collector->collect_one( $providerId, $providerType );
		if ( ! $signals ) {
			return; // Not (yet) an indexed provider -- nothing to score.
		}

		$mean  = $this->collector->platform_mean_rating();
		$score = $this->scorer->score( $signals, $mean );

		$this->indexer->update_ranking( $providerId, $providerType, $score->value, $score->signalKeys );
	}

	/** @return int Number of providers recomputed. */
	public function recompute_all(): int {
		$all_signals = $this->collector->collect_all();
		if ( ! $all_signals ) {
			return 0;
		}

		$mean  = $this->collector->platform_mean_rating();
		$count = 0;

		foreach ( $all_signals as $key => $signals ) {
			[ $provider_id, $provider_type ] = explode( ':', $key, 2 );
			$score = $this->scorer->score( $signals, $mean );
			$this->indexer->update_ranking( (int) $provider_id, $provider_type, $score->value, $score->signalKeys );
			++$count;
		}

		return $count;
	}
}
