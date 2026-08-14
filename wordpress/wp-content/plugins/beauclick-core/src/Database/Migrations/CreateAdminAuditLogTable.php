<?php
declare( strict_types=1 );

namespace BeauClick\Core\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.2 Step 13 (ADMIN-02) — general-purpose administrative audit trail,
 * generalizing the append-only pattern beauclick-marketplace's own
 * wp_bc_verification_history (V2.1 Step 8) already established, for admin
 * actions outside verification: B2B account approval/rejection, review
 * moderation, loyalty tier/plan/benefit configuration, membership
 * grant/cancel. Deliberately a separate table from wp_bc_events (see
 * AuditLogger's own docblock for why) and left independent of
 * wp_bc_verification_history (that table keeps being written by
 * VerificationService directly — this migration does not touch it; the new
 * Audit Log admin page merges both, read-only, into one feed instead of
 * migrating verification's own history into a new shape).
 */
final class CreateAdminAuditLogTable implements Migration {

	public function id(): string {
		return '2026_08_14_create_admin_audit_log_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_admin_audit_log';
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			action_type VARCHAR(64) NOT NULL,
			entity_type VARCHAR(64) NOT NULL,
			entity_id BIGINT UNSIGNED NOT NULL,
			actor_user_id BIGINT UNSIGNED NULL,
			previous_state LONGTEXT NULL,
			new_state LONGTEXT NULL,
			reason VARCHAR(500) NULL,
			created_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			KEY entity (entity_type, entity_id),
			KEY action_type (action_type, created_at),
			KEY actor_user_id (actor_user_id)
		) {$charset_collate};";

		dbDelta( $sql );
	}
}
