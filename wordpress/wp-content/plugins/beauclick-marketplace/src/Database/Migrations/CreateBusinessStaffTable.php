<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.2 Step 16 — the minimal multi-staff model the roadmap's own Step 16
 * boundary named ("a staff-invite-and-permission flow with test-covered
 * ownership boundaries," not a full HR/rostering system). `bc_manage_business_staff`
 * has existed as a declared capability since V1 (RoleManager) with nothing
 * behind it — this table is the first real data backing it.
 *
 * Deliberately a single flat role ('staff') rather than a capability
 * matrix — the task's own "do not create dozens of permissions... if too
 * large, defer" instruction. A staff row grants the SAME access the owner
 * already has on the two surfaces this step wires it into (CRM, own
 * analytics) — see StaffService's own docblock for exactly which surfaces
 * and why finer-grained per-capability staff roles are an explicit,
 * documented V2.3+ boundary, not silently invented here.
 *
 * `business_id` is the bc_professional/bc_business CPT post id (the owner's
 * own provider post — matching wp_bc_bookings.provider_id's existing
 * convention), never a WP user id. No FK to wp_posts, same
 * cross-plugin-activation-order reasoning as every other table in this
 * codebase.
 */
final class CreateBusinessStaffTable implements Migration {

	public function id(): string {
		return '2026_08_15_create_business_staff_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_business_staff (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				business_id BIGINT UNSIGNED NOT NULL,
				user_id BIGINT UNSIGNED NOT NULL,
				role VARCHAR(20) NOT NULL DEFAULT 'staff',
				status VARCHAR(20) NOT NULL DEFAULT 'active',
				added_by BIGINT UNSIGNED NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY business_user (business_id, user_id),
				KEY user_lookup (user_id, status)
			) {$charset_collate};"
		);
	}
}
