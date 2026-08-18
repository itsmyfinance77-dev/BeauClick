<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

use BeauClick\Marketplace\Ranking\RankingPresenter;

/**
 * V2.4 Step 21 (Search & Discovery Evolution): the current, only
 * implementation of SearchProviderInterface — plain, parameterized SQL
 * against wp_bc_provider_index, exactly the query MarketplaceController::
 * browse() and the theme's bc_get_providers() helper each used to build
 * independently (a real, confirmed duplication: both hand-rolled the same
 * city/specialty/q WHERE clause and the same RankingPresenter::ORDER_BY
 * reference, with no shared code between the REST and SSR search paths).
 * Still plain `LIKE`, still no fuzzy/typo-distance matching (that remains
 * the real, evidence-gated MKT-02/GAP-14 deferral this step does not
 * close) — the two real improvements this step adds are character-level
 * normalization (TextNormalizer) and curated-synonym expansion
 * (SynonymExpander), both zero-new-infrastructure.
 */
final class SqlSearchProvider implements SearchProviderInterface {

	public function search( SearchQuery $query ): SearchResult {
		global $wpdb;

		$where  = [ '1=1' ];
		$params = [];

		if ( null !== $query->cityId ) {
			$where[]  = 'city_id = %d';
			$params[] = $query->cityId;
		}
		if ( null !== $query->districtId ) {
			$where[]  = 'district_id = %d';
			$params[] = $query->districtId;
		}
		if ( null !== $query->specialtyId ) {
			$where[]  = 'FIND_IN_SET(%d, specialty_ids)';
			$params[] = $query->specialtyId;
		}
		if ( null !== $query->priceMax ) {
			$where[]  = 'price_from <= %d';
			$params[] = $query->priceMax;
		}
		if ( null !== $query->ratingMin ) {
			$where[]  = 'rating_avg >= %f';
			$params[] = $query->ratingMin;
		}
		if ( $query->verifiedOnly ) {
			$where[] = 'verified = 1';
		}

		$synonymExpanded = false;
		$q               = trim( $query->q );
		if ( '' !== $q ) {
			$normalized = TextNormalizer::normalize( $q );
			$terms      = array_unique( array_merge( [ $normalized ], SynonymExpander::expand( $normalized ) ) );
			$synonymExpanded = count( $terms ) > 1;

			$like_conditions = [];
			foreach ( $terms as $term ) {
				$like_conditions[] = 'search_text LIKE %s';
				$params[]           = '%' . $wpdb->esc_like( $term ) . '%';
			}
			// Parenthesized so a synonym-expanded OR group still ANDs with
			// every structured filter above it — a name/bio match in the
			// wrong city must still be excluded, unchanged from before this
			// step (MarketplaceControllerTest::
			// test_browse_q_combines_with_other_filters).
			$where[] = '(' . implode( ' OR ', $like_conditions ) . ')';
		}

		$table     = $wpdb->prefix . 'bc_provider_index';
		$where_sql = implode( ' AND ', $where );

		$count_sql = "SELECT COUNT(*) FROM {$table} WHERE {$where_sql}";
		$count_sql = $params ? $wpdb->prepare( $count_sql, $params ) : $count_sql; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$total     = (int) $wpdb->get_var( $count_sql );

		$order      = $this->sort_clause( $query->sort );
		$select_sql = "SELECT * FROM {$table} WHERE {$where_sql} ORDER BY {$order} LIMIT %d OFFSET %d";
		$select_sql = $wpdb->prepare( $select_sql, array_merge( $params, [ $query->limit, $query->offset ] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $select_sql, ARRAY_A ) ?: [];

		return new SearchResult( $rows, $total, $synonymExpanded );
	}

	private function sort_clause( string $sort ): string {
		return match ( $sort ) {
			'price_asc'  => 'price_from ASC',
			'price_desc' => 'price_from DESC',
			'rating'     => 'rating_avg DESC, review_count DESC',
			default      => RankingPresenter::ORDER_BY,
		};
	}
}
