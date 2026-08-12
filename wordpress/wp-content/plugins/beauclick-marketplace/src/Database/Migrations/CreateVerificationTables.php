<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.1 Step 8 — three tables, matching the task's own suggested conceptual
 * split (request / evidence / history) without inventing a fourth "review
 * decision" table: one verification request has exactly one terminal
 * decision, so decided_by/decided_at/decision_reason live directly on the
 * request row rather than a separate 1:1 table.
 *
 * `_bc_verification_status` postmeta (V1-era, already the value every
 * consumer — MarketplaceController, MyProfileController, Indexer, ranking
 * — reads) remains the single source of truth for "is this provider
 * verified right now"; these tables are the new audit trail and evidence
 * store layered on top of it, not a competing source of truth. Every
 * transition through VerificationService updates both in the same
 * request, never one without the other.
 *
 * No cross-plugin FK to wp_posts (provider_id), matching every other table
 * in this codebase (WordPress doesn't guarantee plugin activation order).
 */
final class CreateVerificationTables implements Migration {

	public function id(): string {
		return '2026_08_12_create_verification_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_verification_requests (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				submitted_by BIGINT UNSIGNED NOT NULL,
				submitted_at DATETIME NOT NULL,
				decided_by BIGINT UNSIGNED NULL,
				decided_at DATETIME NULL,
				decision_reason VARCHAR(500) NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY provider_status (provider_id, status)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_verification_evidence (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				request_id BIGINT UNSIGNED NOT NULL,
				evidence_type VARCHAR(30) NOT NULL,
				storage_key VARCHAR(191) NOT NULL,
				original_filename VARCHAR(255) NOT NULL,
				mime_type VARCHAR(100) NOT NULL,
				size_bytes BIGINT UNSIGNED NOT NULL,
				uploaded_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY request_id (request_id),
				UNIQUE KEY storage_key (storage_key)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_verification_history (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				request_id BIGINT UNSIGNED NULL,
				from_status VARCHAR(20) NOT NULL,
				to_status VARCHAR(20) NOT NULL,
				actor_user_id BIGINT UNSIGNED NOT NULL,
				reason VARCHAR(500) NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY provider_created (provider_id, created_at)
			) {$charset_collate};"
		);
	}
}
