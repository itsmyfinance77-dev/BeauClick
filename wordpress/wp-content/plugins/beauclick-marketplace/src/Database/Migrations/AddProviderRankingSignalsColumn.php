<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.0 Step 3: `ranking_score` already existed on this table since V1
 * (CreateProviderIndexTable) as a waiting, never-written column — no
 * migration needed to add it. `ranking_signals` is genuinely new: a small
 * JSON array of stable signal KEYS (e.g. ["verified","high_rating"]) that
 * crossed a real, truthful threshold the last time this provider's score was
 * computed (see beauclick-booking\Ranking\RankingScorer), so the frontend
 * can render an honest "چرا این نتیجه" explanation without either exposing
 * the raw numeric score or recomputing the explanation on every read. Keys,
 * not pre-rendered Persian text, so wording can change without a backfill.
 *
 * A separate migration rather than editing CreateProviderIndexTable — that
 * one already shipped, matching this project's established convention (see
 * beauclick-booking's AddHoldExpiryColumns, beauclick-loyalty's
 * AddLoyaltyReferenceUniqueIndex).
 */
final class AddProviderRankingSignalsColumn implements Migration {

	public function id(): string {
		return '2026_08_12_add_provider_ranking_signals_column';
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
