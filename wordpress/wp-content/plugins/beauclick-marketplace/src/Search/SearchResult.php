<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

/**
 * V2.4 Step 21: pairs the matched `wp_bc_provider_index` rows with the
 * search facts every real caller (REST analytics logging, the SSR
 * marketplace page's optional synonym hint) needs — computed once here
 * rather than re-derived independently at each call site.
 */
final class SearchResult {

	/**
	 * @param list<array<string, mixed>> $rows raw wp_bc_provider_index rows,
	 *        each caller still owns shaping these into its own response format
	 *        (MarketplaceController::format_index_row(), the theme's own
	 *        provider-card template) — this class stays presentation-agnostic.
	 */
	public function __construct(
		public readonly array $rows,
		public readonly int $total,
		public readonly bool $synonymExpanded
	) {}

	public function isZeroResult(): bool {
		return 0 === $this->total;
	}
}
