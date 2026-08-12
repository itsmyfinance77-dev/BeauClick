<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Deliberately the only two new tables Beauty Journey needs (architecture
 * doc §4.2 and the task's own "avoid unnecessary schema complexity"
 * instruction) — everything else the journey surfaces (bookings, reviews,
 * orders, AI recommendations, loyalty) is composed at read time from tables
 * that already exist, never duplicated here. See TimelineComposer.
 *
 * wp_bc_beauty_profiles: one row per customer (UNIQUE user_id, same shape as
 * wp_bc_ai_conversations), ongoing low-commitment preferences a customer can
 * set without naming a specific dated goal. `notes` is customer-authored,
 * short, and explicitly never forwarded to an external AI provider (see
 * JourneyContextProvider) — kept conservative on purpose per the task's
 * explicit "must NOT become a medical-record system" instruction; there is
 * no dedicated medical/health field anywhere in this schema.
 *
 * wp_bc_beauty_goals: many rows per customer, a specific, nameable,
 * time-boundable objective ("آماده شدن برای عروسی") distinct from the
 * general profile. No cross-plugin foreign keys, matching every other table
 * in this codebase (WordPress doesn't guarantee plugin activation order).
 */
final class CreateJourneyTables implements Migration {

	public function id(): string {
		return '2026_08_13_create_journey_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_beauty_profiles (
				user_id BIGINT UNSIGNED NOT NULL,
				preferred_city_id BIGINT UNSIGNED NULL,
				preferred_specialty_ids VARCHAR(255) NULL,
				budget_min BIGINT UNSIGNED NULL,
				budget_max BIGINT UNSIGNED NULL,
				notes VARCHAR(500) NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (user_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_beauty_goals (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				title VARCHAR(191) NOT NULL,
				specialty_id BIGINT UNSIGNED NULL,
				city_id BIGINT UNSIGNED NULL,
				budget BIGINT UNSIGNED NULL,
				target_date DATE NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'active',
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY user_status (user_id, status)
			) {$charset_collate};"
		);
	}
}
