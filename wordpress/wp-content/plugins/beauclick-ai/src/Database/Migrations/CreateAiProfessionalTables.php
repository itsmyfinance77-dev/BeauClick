<?php
declare( strict_types=1 );

namespace BeauClick\AI\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.3 Step 19 — a separate schema from `wp_bc_ai_conversations`, not a
 * modification of it. That table's `UNIQUE KEY user_id (user_id)` is a real
 * architectural blocker for professional AI: a professional is also a WP
 * user, and if their customer-mode conversation and their business-data
 * conversation shared the same `user_id` key, they could never coexist (one
 * row per user_id, period) — worse, any bug conflating the two would leak a
 * professional's own customer-shopping history into a business-data prompt
 * or vice versa. Rather than adding a `scope` column and widening the
 * unique key on a live, working table (real regression risk to the existing
 * customer AI path for zero benefit), this is a clean, additive, new table
 * pair — matching this codebase's own repeated "extend, don't touch what
 * already works" discipline (see V2.2 Step 8/13's own stated reasoning for
 * the same choice).
 *
 * Identity here is deliberately keyed on `provider_id` (the owned
 * `bc_professional`/`bc_business` CPT post id), not `user_id` — the
 * professional AI's conversation belongs to the BUSINESS, the same way
 * every other Step 19-adjacent table (ledger, settlements, campaigns) keys
 * on a party/provider id rather than a WP user id. `user_id` is still
 * stored (who is currently allowed to use it — see ProfessionalAssistantService,
 * owner-only, no staff fallback in this phase) but is not the identity key.
 * This also leaves room for a future staff-inclusive design to be purely an
 * authorization-logic change, never a schema change.
 */
final class CreateAiProfessionalTables implements Migration {

	public function id(): string {
		return '2026_08_15_create_ai_professional_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		// No ai_context column, unlike wp_bc_ai_conversations: a professional's
		// question is always answered from FRESH real data (ProfessionalContext
		// rebuilds it on every turn from MetricsService/SettlementService/
		// CampaignService), never a cached/accumulated snapshot from an earlier
		// turn -- "your revenue right now" must never read stale numbers.
		dbDelta(
			"CREATE TABLE {$prefix}bc_ai_professional_conversations (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				user_id BIGINT UNSIGNED NOT NULL,
				created_at DATETIME NOT NULL,
				last_message_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY provider_id (provider_id),
				KEY user_id (user_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_ai_professional_messages (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				conversation_id BIGINT UNSIGNED NOT NULL,
				sender_id BIGINT UNSIGNED NULL,
				body TEXT NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY conversation_created (conversation_id, created_at)
			) {$charset_collate};"
		);
	}
}
