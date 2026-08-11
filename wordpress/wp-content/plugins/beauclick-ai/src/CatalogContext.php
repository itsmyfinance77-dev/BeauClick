<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Feeds a slice of the REAL catalog into the LLM prompt so it only ever
 * has real IDs to choose from in the first place — a second, independent
 * layer of defense on top of AssistantService::send()'s own DB validation
 * (architecture doc §16: never trust the model's IDs blindly, at either
 * layer alone).
 */
final class CatalogContext {

	/** @return array<int, array{id: int, name: string, cityId: int|null, priceFrom: int|null, rating: float}> */
	public function summary( array $context, int $limit = 10 ): array {
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
}
