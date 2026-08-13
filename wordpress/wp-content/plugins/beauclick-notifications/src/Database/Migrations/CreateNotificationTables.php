<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.1 Step 10 — the central notification service's own two tables.
 *
 * `wp_bc_notifications` is a real delivery record (one row per
 * template/entity/user/channel attempt), NOT a queue — every notify() call
 * in this plugin dispatches synchronously (SMS/email at this project's
 * real, low volume is fast and simple; a real async queue would be
 * over-engineering at current scale, matching the task's own "avoid
 * Redis/Kafka/etc merely because they're popular" instruction). The
 * `idempotency_key` UNIQUE constraint is the hard guarantee against a
 * scheduler firing twice or a retry double-sending — the exact same
 * "fast-path has_awarded() check backed by a DB-level UNIQUE index"
 * pattern already established by beauclick-loyalty's own
 * AddLoyaltyReferenceUniqueIndex.
 *
 * `wp_bc_notification_preferences` is deliberately per-CATEGORY, not
 * per-category-per-channel — a combinatorial preference matrix nobody
 * asked for. One row per (user_id, category); absence of a row means
 * "enabled" (opt-out model, not opt-in) — see PreferenceService.
 */
final class CreateNotificationTables implements Migration {

	public function id(): string {
		return '2026_08_13_create_notification_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_notifications (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				category VARCHAR(20) NOT NULL,
				template_key VARCHAR(40) NOT NULL,
				channel VARCHAR(10) NOT NULL,
				recipient VARCHAR(191) NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				idempotency_key VARCHAR(191) NOT NULL,
				entity_type VARCHAR(30) NULL,
				entity_id BIGINT UNSIGNED NULL,
				error VARCHAR(255) NULL,
				attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL,
				sent_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY idempotency (idempotency_key),
				KEY user_status (user_id, status),
				KEY entity (entity_type, entity_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_notification_preferences (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				category VARCHAR(20) NOT NULL,
				enabled TINYINT(1) NOT NULL DEFAULT 1,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_category (user_id, category)
			) {$charset_collate};"
		);
	}
}
