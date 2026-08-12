<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Ranking;

/**
 * RankingScorer's output: a composite 0-100 score plus the specific signal
 * keys that genuinely earned their explanation this computation — the
 * boundary between "internal, technical" (value) and "external, truthful"
 * (signalKeys, consumed by beauclick-marketplace\Ranking\RankingPresenter)
 * per the roadmap's own "internal score may stay technical, explanations
 * must be truthful" requirement.
 */
final class RankingScore {

	/** @param array<int, string> $signalKeys */
	public function __construct(
		public readonly float $value, // 0-100
		public readonly array $signalKeys
	) {
	}
}
