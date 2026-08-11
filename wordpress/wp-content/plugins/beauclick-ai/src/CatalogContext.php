<?php
declare( strict_types=1 );

namespace BeauClick\AI;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * Feeds a slice of the REAL catalog into the LLM prompt so it only ever
 * has real IDs to choose from in the first place — a second, independent
 * layer of defense on top of AssistantService::send()'s own DB validation
 * (architecture doc §16: never trust the model's IDs blindly, at either
 * layer alone).
 *
 * V2.0 Step 2: extended beyond providers to also include real products and
 * services, mirroring RuleBasedProvider's own matching so a real-LLM
 * provider has the same three catalog types to recommend from — an external
 * model can only pick a type it's shown, so leaving products/services out
 * here would have silently limited AnthropicProvider to professional-only
 * recommendations.
 */
final class CatalogContext {

	/** @return array<int, array<string, mixed>> */
	public function summary( array $context, int $limit = 10 ): array {
		return array_merge(
			$this->providers( $context, $limit ),
			$this->services( $context, $limit ),
			$this->products( $context, $limit )
		);
	}

	/** @return array<int, array{type: string, id: int, name: string, cityId: int|null, priceFrom: int|null, rating: float}> */
	private function providers( array $context, int $limit ): array {
		global $wpdb;

		$where  = [ '1=1' ];
		$params = [];

		if ( ! empty( $context['specialtyIds'] ) ) {
			$or = [];
			foreach ( (array) $context['specialtyIds'] as $id ) {
				$or[]     = 'FIND_IN_SET(%d, specialty_ids)';
				$params[] = (int) $id;
			}
			$where[] = '(' . implode( ' OR ', $or ) . ')';
		}
		if ( ! empty( $context['cityId'] ) ) {
			$where[]  = 'city_id = %d';
			$params[] = (int) $context['cityId'];
		}

		$sql = 'SELECT provider_id, name, city_id, price_from, rating_avg FROM ' . $wpdb->prefix . "bc_provider_index WHERE {$where[0]}"
			. ( count( $where ) > 1 ? ' AND ' . implode( ' AND ', array_slice( $where, 1 ) ) : '' )
			. ' ORDER BY verified DESC, rating_avg DESC LIMIT %d';
		$params[] = $limit;
		$sql      = $wpdb->prepare( $sql, $params ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $sql, ARRAY_A );

		return array_map(
			static fn ( array $r ) => [
				'type'      => 'provider',
				'id'        => (int) $r['provider_id'],
				'name'      => $r['name'],
				'cityId'    => $r['city_id'] ? (int) $r['city_id'] : null,
				'priceFrom' => null !== $r['price_from'] ? (int) $r['price_from'] : null,
				'rating'    => (float) $r['rating_avg'],
			],
			$rows ?: []
		);
	}

	/** @return array<int, array{type: string, id: int, name: string, price: int, providerId: int}> */
	private function services( array $context, int $limit ): array {
		if ( empty( $context['specialtyIds'] ) ) {
			return [];
		}

		$services = get_posts(
			[
				'post_type'      => Registrar::SERVICE,
				'post_status'    => 'publish',
				'posts_per_page' => $limit * 2,
				'tax_query'      => [ // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
					[
						'taxonomy' => Registrar::SPECIALTY,
						'field'    => 'term_id',
						'terms'    => array_map( 'intval', (array) $context['specialtyIds'] ),
					],
				],
			]
		);

		$city_id = ! empty( $context['cityId'] ) ? (int) $context['cityId'] : null;
		$out     = [];
		foreach ( $services as $service ) {
			if ( count( $out ) >= $limit ) {
				break;
			}
			$parent = get_post( $service->post_parent );
			if ( ! $parent || 'publish' !== $parent->post_status ) {
				continue;
			}
			// Same city constraint as RuleBasedProvider::find_services() --
			// a real LLM provider must not even be OFFERED an out-of-city
			// service to choose from when the user named a city.
			if ( null !== $city_id && (int) get_post_meta( $parent->ID, '_bc_city_id', true ) !== $city_id ) {
				continue;
			}
			$out[] = [
				'type'       => 'service',
				'id'         => $service->ID,
				'name'       => $service->post_title,
				'price'      => (int) get_post_meta( $service->ID, '_bc_price', true ),
				'providerId' => (int) $service->post_parent,
			];
		}
		return $out;
	}

	/** @return array<int, array{type: string, id: int, name: string, price: int}> */
	private function products( array $context, int $limit ): array {
		if ( empty( $context['productCategoryIds'] ) || ! function_exists( 'wc_get_products' ) ) {
			return [];
		}

		$slugs = [];
		foreach ( (array) $context['productCategoryIds'] as $term_id ) {
			$term = get_term( (int) $term_id, 'product_cat' );
			if ( $term && ! is_wp_error( $term ) ) {
				$slugs[] = $term->slug;
			}
		}
		if ( ! $slugs ) {
			return [];
		}

		$products = wc_get_products(
			[
				'category' => $slugs,
				'status'   => 'publish',
				'limit'    => $limit,
			]
		);

		$out = [];
		foreach ( $products as $product ) {
			// Same visibility rule as RuleBasedProvider::find_products() —
			// a hidden booking-only product must never even be OFFERED to
			// the model as something it could recommend.
			if ( ! $product->is_visible() ) {
				continue;
			}
			$out[] = [
				'type'  => 'product',
				'id'    => $product->get_id(),
				'name'  => $product->get_name(),
				'price' => (int) $product->get_price(),
			];
		}
		return $out;
	}
}
