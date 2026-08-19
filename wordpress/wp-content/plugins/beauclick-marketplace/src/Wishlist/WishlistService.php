<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Wishlist;

/**
 * Sole owner of `wp_bc_wishlist_items` — every read/write goes through this
 * class, matching the one-service-per-table-group convention already
 * established throughout this codebase (CampaignService, TierService).
 */
final class WishlistService {

	/** INSERT IGNORE against UNIQUE(customer_id, provider_id) -- a repeated add is a harmless no-op, never a duplicate row. */
	public function add( int $customer_id, int $provider_id ): bool {
		global $wpdb;
		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->prefix}bc_wishlist_items (customer_id, provider_id, created_at) VALUES (%d, %d, %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$customer_id,
				$provider_id,
				current_time( 'mysql' )
			)
		);
		return (bool) $inserted;
	}

	/** Removing an item that was never wishlisted is a harmless no-op, same idempotency discipline as add(). */
	public function remove( int $customer_id, int $provider_id ): bool {
		global $wpdb;
		$deleted = $wpdb->delete(
			$wpdb->prefix . 'bc_wishlist_items',
			[ 'customer_id' => $customer_id, 'provider_id' => $provider_id ]
		);
		return (bool) $deleted;
	}

	public function contains( int $customer_id, int $provider_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_wishlist_items WHERE customer_id = %d AND provider_id = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$customer_id,
				$provider_id
			)
		);
	}

	/** @return list<int> Provider ids this customer has wishlisted, most-recently-added first. */
	public function provider_ids_for( int $customer_id ): array {
		global $wpdb;
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT provider_id FROM {$wpdb->prefix}bc_wishlist_items WHERE customer_id = %d ORDER BY id DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$customer_id
			)
		);
		return array_map( 'intval', $ids ?: [] );
	}
}
