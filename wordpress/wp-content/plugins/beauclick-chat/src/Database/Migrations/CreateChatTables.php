<?php
declare( strict_types=1 );

namespace BeauClick\Chat\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * A conversation is between exactly two users (architecture doc §8/§15:
 * customer + counterpart — professional/business/support; `type='ai'` is
 * reserved for beauclick-ai reusing this same schema, per §8). Participants
 * are stored in canonical (smaller id, larger id) order rather than
 * customer_id/counterpart_id — that's what lets a single UNIQUE key prevent
 * duplicate conversations regardless of who messages first, with no OR-based
 * lookup query needed either. No FK to wp_users (same cross-plugin/activation-
 * order reasoning as every other module's tables).
 */
final class CreateChatTables implements Migration {

	public function id(): string {
		return '2026_08_11_create_chat_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_conversations (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				type VARCHAR(20) NOT NULL DEFAULT 'pro',
				participant_a_id BIGINT UNSIGNED NOT NULL,
				participant_b_id BIGINT UNSIGNED NOT NULL,
				last_message_at DATETIME NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY participants (participant_a_id, participant_b_id, type),
				KEY participant_b (participant_b_id, last_message_at)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_messages (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				conversation_id BIGINT UNSIGNED NOT NULL,
				sender_id BIGINT UNSIGNED NULL,
				body TEXT NOT NULL,
				created_at DATETIME NOT NULL,
				read_at DATETIME NULL,
				PRIMARY KEY  (id),
				KEY conversation_created (conversation_id, created_at)
			) {$charset_collate};"
		);
	}
}
