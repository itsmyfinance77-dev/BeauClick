<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Denormalized, indexed search table behind marketplace discovery —
 * architecture doc §8/§11. Marketplace filtering (city + district +
 * specialty + price range + rating, sorted) is the single highest-traffic
 * query in the product; WP meta queries don't index combinations well at
 * scale, so this flat table is rebuilt (via Search\Indexer) whenever a
 * provider's profile/services/reviews change, rather than querying CPT
 * meta live on every search request.
 */
final class CreateProviderIndexTable implements Migration {

	public function id(): string {
		return '2026_08_10_create_provider_index_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_provider_index';
		$charset_collate = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE {$table} (
				provider_id BIGINT UNSIGNED NOT NULL,
				provider_type VARCHAR(20) NOT NULL,
				owner_user_id BIGINT UNSIGNED NOT NULL,
				name VARCHAR(191) NOT NULL,
				city_id BIGINT UNSIGNED NULL,
				district_id BIGINT UNSIGNED NULL,
				specialty_ids VARCHAR(255) NULL,
				price_from BIGINT UNSIGNED NULL,
				rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0,
				review_count INT UNSIGNED NOT NULL DEFAULT 0,
				verified TINYINT(1) NOT NULL DEFAULT 0,
				ranking_score DECIMAL(10,4) NULL,
				last_active_at DATETIME NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (provider_id, provider_type),
				KEY city_filter (city_id, district_id),
				KEY price_from (price_from),
				KEY rating_avg (rating_avg),
				KEY verified (verified)
			) {$charset_collate};"
		);
	}
}
