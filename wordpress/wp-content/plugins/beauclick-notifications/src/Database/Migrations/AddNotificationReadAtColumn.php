<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.4 Step 24 (Notification & Communication Improvements): the in-app
 * notification center (bell + unread count) needs a genuine read/unread
 * concept, which `wp_bc_notifications` never had — `status` tracks
 * DELIVERY outcome (pending/sent/failed/suppressed/duplicate), not whether
 * the recipient has actually seen it in the UI, a materially different
 * fact. `read_at` is nullable and starts NULL for every existing row (an
 * honest "we don't know, this predates the read concept," never
 * backfilled to a fabricated timestamp) — a pre-existing notification
 * simply starts out unread the first time this feature runs, which is
 * the correct, honest default, not a bug.
 *
 * A separate migration rather than editing CreateNotificationTables —
 * matching this codebase's own established convention (see
 * AddProviderSearchTextColumn's own docblock for the same reasoning).
 */
final class AddNotificationReadAtColumn implements Migration {

	public function id(): string {
		return '2026_08_19_add_notification_read_at_column';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_notifications';
		$charset_collate = $wpdb->get_charset_collate();

		// dbDelta diffs the full CREATE TABLE against the live schema and
		// issues only the necessary ALTER TABLE ADD COLUMN — not a re-create.
		dbDelta(
			"CREATE TABLE {$table} (
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
				read_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY idempotency (idempotency_key),
				KEY user_status (user_id, status),
				KEY entity (entity_type, entity_id),
				KEY user_unread (user_id, read_at)
			) {$charset_collate};"
		);
	}
}
