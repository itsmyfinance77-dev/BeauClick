<?php
declare( strict_types=1 );

namespace BeauClick\Core\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Append-only event log. This is the one deliberately forward-looking table
 * in the schema (architecture doc §8/§21): the AI-driven professional
 * ranking the business plan treats as the core competitive advantage
 * (booking count, cancellation rate, response time, profile views, review
 * sentiment) cannot be computed retroactively if the raw events weren't
 * captured from day one. The scoring algorithm itself is a later phase —
 * this table just makes sure we're not missing the inputs when that phase
 * starts.
 */
final class CreateEventsTable implements Migration {

	public function id(): string {
		return '2026_08_10_create_events_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_events';
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			event_type VARCHAR(64) NOT NULL,
			entity_type VARCHAR(64) NOT NULL,
			entity_id BIGINT UNSIGNED NOT NULL,
			actor_id BIGINT UNSIGNED NULL,
			meta LONGTEXT NULL,
			created_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			KEY entity (entity_type, entity_id),
			KEY event_type (event_type, created_at),
			KEY actor_id (actor_id)
		) {$charset_collate};";

		dbDelta( $sql );
	}
}
