<?php
declare( strict_types=1 );

namespace BeauClick\Locations\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Province -> City -> District as plain relational tables, not a WP
 * taxonomy — see architecture doc §10. Reasons: fast composite-indexed
 * filter joins (city_id + district_id are queried on every marketplace
 * search), lat/lng for future "near me" search, and an is_launched flag
 * that drives which cities actually appear as filter options without
 * touching term meta. No FK constraints to other plugins' tables — WP
 * doesn't guarantee plugin activation order (architecture doc §8 note).
 */
final class CreateLocationTables implements Migration {

	public function id(): string {
		return '2026_08_10_create_location_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_provinces (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				name_fa VARCHAR(100) NOT NULL,
				slug VARCHAR(100) NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_cities (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				province_id BIGINT UNSIGNED NOT NULL,
				name_fa VARCHAR(100) NOT NULL,
				slug VARCHAR(100) NOT NULL,
				lat DECIMAL(9,6) NULL,
				lng DECIMAL(9,6) NULL,
				is_launched TINYINT(1) NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY province_id (province_id),
				KEY is_launched (is_launched)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_districts (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				city_id BIGINT UNSIGNED NOT NULL,
				name_fa VARCHAR(100) NOT NULL,
				slug VARCHAR(100) NOT NULL,
				PRIMARY KEY  (id),
				KEY city_id (city_id),
				UNIQUE KEY city_slug (city_id, slug)
			) {$charset_collate};"
		);
	}
}
