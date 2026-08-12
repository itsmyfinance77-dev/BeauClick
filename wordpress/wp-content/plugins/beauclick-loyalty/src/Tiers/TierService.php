<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tiers;

use BeauClick\Loyalty\LoyaltyLedger;

/**
 * V2.1 Step 9 — deterministic tier qualification. A customer's tier is
 * NEVER stored; it is always computed from `LoyaltyLedger::lifetime_earned()`
 * against the configurable `wp_bc_loyalty_tiers` table, so there is no
 * cache to go stale and no second source of truth to keep in sync with the
 * ledger. Qualification rule: the highest ACTIVE tier whose
 * `threshold_points <= lifetime_earned` (`>=`, not `>` -- a customer who
 * reaches a threshold exactly already qualifies; verified explicitly by
 * this class's own boundary tests). Tiers are configured by an admin, never
 * hardcoded names/thresholds in PHP.
 */
final class TierService {

	/** @return list<array{id:int,slug:string,name:string,thresholdPoints:int,sortOrder:int,isActive:bool}> Ordered by threshold ascending. */
	public function all( bool $active_only = false ): array {
		global $wpdb;
		$where = $active_only ? 'WHERE is_active = 1' : '';
		$rows  = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_loyalty_tiers {$where} ORDER BY threshold_points ASC", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_loyalty_tiers WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	/** The highest active tier the given lifetime-points total qualifies for, or null if it qualifies for none (below every configured threshold, or no tiers configured at all). */
	public function for_points( int $lifetime_points ): ?array {
		$qualifying = null;
		foreach ( $this->all( true ) as $tier ) {
			if ( $lifetime_points >= $tier['thresholdPoints'] ) {
				$qualifying = $tier; // Tiers are iterated threshold-ascending, so the last match is the highest qualifying tier.
			}
		}
		return $qualifying;
	}

	/** @return array{lifetimePoints:int,currentTier:?array,nextTier:?array,pointsToNext:?int,percentToNext:?float} */
	public function progress_for_user( int $user_id ): array {
		$lifetime = ( new LoyaltyLedger() )->lifetime_earned( $user_id );
		$current  = $this->for_points( $lifetime );
		$active   = $this->all( true );

		$next = null;
		foreach ( $active as $tier ) {
			if ( $tier['thresholdPoints'] > $lifetime ) {
				$next = $tier;
				break; // Ascending order -- the first tier above the current total is the very next one.
			}
		}

		$points_to_next  = $next ? max( 0, $next['thresholdPoints'] - $lifetime ) : null;
		$percent_to_next = null;
		if ( $next ) {
			$floor           = $current['thresholdPoints'] ?? 0;
			$span            = max( 1, $next['thresholdPoints'] - $floor ); // max(1,...) -- guards a zero-width span (two tiers configured at the same threshold) from a division by zero.
			$percent_to_next = round( min( 100, max( 0, ( ( $lifetime - $floor ) / $span ) * 100 ) ), 1 );
		}

		return [
			'lifetimePoints' => $lifetime,
			'currentTier'    => $current,
			'nextTier'       => $next,
			'pointsToNext'   => $points_to_next,
			'percentToNext'  => $percent_to_next,
		];
	}

	/** @return array{id:int}|string Error message on validation failure. */
	public function create( string $slug, string $name, int $threshold_points, int $sort_order = 0 ) {
		if ( '' === trim( $slug ) || '' === trim( $name ) ) {
			return 'نام و شناسه سطح الزامی است.';
		}
		if ( $threshold_points < 0 ) {
			return 'حد نصاب امتیاز نمی‌تواند منفی باشد.';
		}

		global $wpdb;
		$now    = current_time( 'mysql' );
		$result = $wpdb->insert(
			$wpdb->prefix . 'bc_loyalty_tiers',
			[
				'slug'             => sanitize_key( $slug ),
				'name'             => $name,
				'threshold_points' => $threshold_points,
				'sort_order'       => $sort_order,
				'is_active'        => 1,
				'created_at'       => $now,
				'updated_at'       => $now,
			],
			[ '%s', '%s', '%d', '%d', '%d', '%s', '%s' ]
		);

		if ( ! $result ) {
			return 'این شناسه سطح قبلاً استفاده شده است.';
		}
		return [ 'id' => (int) $wpdb->insert_id ];
	}

	/** @param array<string, mixed> $fields */
	public function update( int $id, array $fields ) {
		global $wpdb;
		$data   = [];
		$format = [];

		if ( isset( $fields['name'] ) ) {
			$data['name'] = (string) $fields['name'];
			$format[]     = '%s';
		}
		if ( isset( $fields['thresholdPoints'] ) ) {
			if ( (int) $fields['thresholdPoints'] < 0 ) {
				return 'حد نصاب امتیاز نمی‌تواند منفی باشد.';
			}
			$data['threshold_points'] = (int) $fields['thresholdPoints'];
			$format[]                 = '%d';
		}
		if ( isset( $fields['sortOrder'] ) ) {
			$data['sort_order'] = (int) $fields['sortOrder'];
			$format[]           = '%d';
		}
		if ( isset( $fields['isActive'] ) ) {
			$data['is_active'] = ! empty( $fields['isActive'] ) ? 1 : 0;
			$format[]          = '%d';
		}

		if ( ! $data ) {
			return $this->find( $id ) ?? 'سطح پیدا نشد.';
		}

		$data['updated_at'] = current_time( 'mysql' );
		$format[]            = '%s';

		$wpdb->update( $wpdb->prefix . 'bc_loyalty_tiers', $data, [ 'id' => $id ], $format, [ '%d' ] );
		return $this->find( $id ) ?? 'سطح پیدا نشد.';
	}

	private function format( array $row ): array {
		return [
			'id'              => (int) $row['id'],
			'slug'            => $row['slug'],
			'name'            => $row['name'],
			'thresholdPoints' => (int) $row['threshold_points'],
			'sortOrder'       => (int) $row['sort_order'],
			'isActive'        => (bool) $row['is_active'],
		];
	}
}
