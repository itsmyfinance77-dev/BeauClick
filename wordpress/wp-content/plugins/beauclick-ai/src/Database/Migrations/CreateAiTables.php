<?php
declare( strict_types=1 );

namespace BeauClick\AI\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * A dedicated schema rather than reusing beauclick-chat's tables (which
 * architecture doc §8 floats as an option) — chat's ConversationService is
 * built around two real, distinct human participants (ownership checks,
 * unread-per-participant), which doesn't fit an AI conversation cleanly.
 * One user has exactly one ongoing AI conversation (UNIQUE on user_id) —
 * simpler than a conversation list, and matches §16's "AI conversations
 * don't need polling — synchronous request/response" (no multi-thread UI
 * to justify a list).
 */
final class CreateAiTables implements Migration {

	public function id(): string {
		return '2026_08_11_create_ai_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_ai_conversations (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				ai_context LONGTEXT NULL,
				created_at DATETIME NOT NULL,
				last_message_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_id (user_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_ai_messages (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				conversation_id BIGINT UNSIGNED NOT NULL,
				sender_id BIGINT UNSIGNED NULL,
				body TEXT NOT NULL,
				recommendations LONGTEXT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY conversation_created (conversation_id, created_at)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_ai_recommendation_events (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				conversation_id BIGINT UNSIGNED NOT NULL,
				message_id BIGINT UNSIGNED NOT NULL,
				recommended_type VARCHAR(20) NOT NULL,
				recommended_id BIGINT UNSIGNED NOT NULL,
				clicked TINYINT(1) NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY conversation_id (conversation_id),
				KEY recommended (recommended_type, recommended_id)
			) {$charset_collate};"
		);
	}
}
