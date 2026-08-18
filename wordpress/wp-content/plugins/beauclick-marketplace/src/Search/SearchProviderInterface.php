<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

/**
 * V2.4 Step 21: the one seam a future full-text search backend (OpenSearch
 * or otherwise) would implement — mirrors this codebase's own established
 * provider-abstraction shape (SmsProvider, beauclick-ai's ProviderInterface):
 * one small interface, application code depends only on this, never on a
 * concrete implementation's own query mechanics. SqlSearchProvider is the
 * only implementation today, and is expected to remain so until there is a
 * real, evidence-based reason to add a second — this interface exists so
 * that day doesn't require touching MarketplaceController or
 * bc_get_providers() at all, not because a second implementation is planned.
 */
interface SearchProviderInterface {

	public function search( SearchQuery $query ): SearchResult;
}
