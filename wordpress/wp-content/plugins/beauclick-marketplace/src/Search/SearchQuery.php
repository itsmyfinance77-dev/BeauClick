<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

/**
 * V2.4 Step 21: the one shape both real search entry points build — the
 * REST browse() endpoint and the SSR bc_get_providers() theme helper —
 * instead of each hand-rolling its own WHERE clause against
 * wp_bc_provider_index (the exact drift this step exists to remove; see
 * SqlSearchProvider's own docblock). A plain, immutable parameter object,
 * not an active-record/query-builder — MarketplaceController and
 * bc_get_providers() each still own translating *their* input source
 * (a WP_REST_Request, a plain $args array) into this shape.
 */
final class SearchQuery {

	public function __construct(
		public readonly ?int $cityId = null,
		public readonly ?int $districtId = null,
		public readonly ?int $specialtyId = null,
		public readonly ?int $priceMax = null,
		public readonly ?float $ratingMin = null,
		public readonly bool $verifiedOnly = false,
		public readonly string $q = '',
		public readonly string $sort = '',
		public readonly int $limit = 12,
		public readonly int $offset = 0
	) {}
}
