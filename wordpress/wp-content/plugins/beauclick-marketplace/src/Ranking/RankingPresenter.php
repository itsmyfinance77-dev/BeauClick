<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Ranking;

/**
 * V2.0 Step 3 — the shared "read side" of ranking, owned by marketplace
 * because it owns wp_bc_provider_index (the table ranking_score/
 * ranking_signals live on) and is the one module every other ranking
 * consumer already depends on (ai -> marketplace, booking -> marketplace,
 * theme -> either). The actual SCORE COMPUTATION lives in
 * beauclick-booking\Ranking (see that plugin's own docblock for why) — this
 * class only knows how to consume the result: one ORDER BY every candidate
 * query should use, and one way to turn stored signal keys into truthful
 * Persian explanation text.
 *
 * Before this step, four separate call sites each hardcoded their own copy
 * of 'verified DESC, rating_avg DESC' (MarketplaceController::sort_clause(),
 * the theme's bc_get_providers(), RuleBasedProvider::find_providers(),
 * CatalogContext's provider query) — exactly the "one ranking domain,
 * multiple consumers" duplication this step exists to remove. All four now
 * reference ORDER_BY instead of their own copy.
 */
final class RankingPresenter {

	/**
	 * COALESCE handles any row a recompute hasn't reached yet (e.g. between
	 * this migration running and the first cron/edit-triggered recompute) —
	 * such a row sorts as if it scored 0, never crashes ORDER BY or sorts
	 * ahead of real scores. provider_id ASC is the final, absolute
	 * tiebreaker: two providers can never render in a different relative
	 * order between two requests, pages, or consumers.
	 */
	public const ORDER_BY = 'COALESCE(ranking_score, 0) DESC, verified DESC, rating_avg DESC, provider_id ASC';

	/**
	 * Signal keys a score computation may record (see
	 * beauclick-booking\Ranking\RankingScorer::SIGNAL_* constants) mapped to
	 * short, truthful Persian explanation text. A key only ever appears in a
	 * provider's stored ranking_signals if the underlying signal genuinely
	 * crossed its threshold at last computation — this map only supplies
	 * wording, never the truthfulness decision itself.
	 */
	private const LABELS = [
		'verified'       => 'تأیید شده',
		'high_rating'    => 'امتیاز بالا',
		'fast_response'  => 'پاسخ‌گویی سریع',
		'recent_activity' => 'فعالیت اخیر',
		'complete_profile' => 'پروفایل کامل',
		'reliable'       => 'نرخ تکمیل بالا',
	];

	/**
	 * @param array<int, string> $signalKeys As stored in provider_index.ranking_signals
	 * @return array<int, string> Persian phrases, unknown/legacy keys silently dropped rather than shown raw
	 */
	public static function explain( array $signalKeys ): array {
		$reasons = [];
		foreach ( $signalKeys as $key ) {
			if ( isset( self::LABELS[ $key ] ) ) {
				$reasons[] = self::LABELS[ $key ];
			}
		}
		return $reasons;
	}
}
