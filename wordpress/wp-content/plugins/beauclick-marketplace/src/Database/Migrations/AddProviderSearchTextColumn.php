<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;
use BeauClick\Marketplace\Search\Indexer;

/**
 * V2.3 Step 20 (MKT-02 audit finding): marketplace browse() had no
 * free-text search at all — not "no fuzzy matching," an actual missing
 * search box. `search_text` is a single, pre-normalized, lowercased
 * concatenation of the provider's name + bio (Indexer::sync() builds it),
 * matched with a `LIKE %term%` against a normalized query — the same
 * normalize-then-substring-match idea CrmService::normalize_digits() /
 * list_customers() already established for CRM search, adapted to a SQL
 * LIKE over wp_bc_provider_index (paginated at the SQL layer) rather than
 * CRM's PHP array_filter over an already-small, per-provider result set.
 * A single denormalized column rather than separate normalized name/bio
 * columns — nothing in this feature ever needs to search one without the
 * other, and Step 20 explicitly scopes this to plain LIKE, not a fuzzy/
 * full-text engine (still evidence-gated, see MKT-02's own recommendation).
 *
 * A separate migration rather than editing CreateProviderIndexTable —
 * matching this table's own established convention (see
 * AddProviderRankingSignalsColumn).
 */
final class AddProviderSearchTextColumn implements Migration {

	public function id(): string {
		return '2026_08_15_add_provider_search_text_column';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_provider_index';
		$charset_collate = $wpdb->get_charset_collate();

		// dbDelta diffs the full CREATE TABLE against the live schema and
		// issues only the necessary ALTER TABLE ADD COLUMN — not a re-create.
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
				ranking_signals TEXT NULL,
				search_text TEXT NULL,
				last_active_at DATETIME NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (provider_id, provider_type),
				KEY city_filter (city_id, district_id),
				KEY price_from (price_from),
				KEY rating_avg (rating_avg),
				KEY verified (verified)
			) {$charset_collate};"
		);

		// Adding the column doesn't populate it for providers indexed before
		// this migration ran — Indexer::sync() only writes search_text going
		// forward, on save. Backfill once here (reusing Indexer::sync()
		// itself, not a second name+bio computation) so the column is
		// immediately useful everywhere this migration runs, not only for
		// providers someone happens to re-save later.
		$existing = $wpdb->get_results( "SELECT provider_id, provider_type FROM {$table}", ARRAY_A );
		$indexer  = new Indexer();
		foreach ( $existing as $row ) {
			$indexer->sync( (int) $row['provider_id'], $row['provider_type'] );
		}
	}
}
