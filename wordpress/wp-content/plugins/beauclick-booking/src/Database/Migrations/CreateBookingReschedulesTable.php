<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.2 Step 15 — an append-only reschedule history, the same shape as
 * `wp_bc_verification_history`/the general admin audit log (V2.1 Step 8/
 * V2.2 Step 13): every real reschedule gets exactly one row, application
 * code never updates or deletes one, so "who rescheduled, when, from which
 * slot, to which slot, why" is always answerable directly from this table
 * rather than reconstructed from booking's own current (post-move) state.
 * `reschedule_count` for eligibility is a plain `COUNT(*) ... WHERE
 * booking_id = ?` against this table (see RescheduleService) rather than a
 * redundant counter column on `bc_bookings` — one source of truth, and
 * cheap at this project's real volume (same reasoning Step 11's analytics
 * work already applied to skip a cache table).
 */
final class CreateBookingReschedulesTable implements Migration {

	public function id(): string {
		return '2026_08_14_create_booking_reschedules_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_booking_reschedules (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				booking_id BIGINT UNSIGNED NOT NULL,
				old_slot_id BIGINT UNSIGNED NOT NULL,
				new_slot_id BIGINT UNSIGNED NOT NULL,
				old_slot_start DATETIME NOT NULL,
				old_slot_end DATETIME NOT NULL,
				new_slot_start DATETIME NOT NULL,
				new_slot_end DATETIME NOT NULL,
				actor_id BIGINT UNSIGNED NOT NULL,
				actor_role VARCHAR(20) NOT NULL,
				reason VARCHAR(255) NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY booking_id (booking_id, created_at)
			) {$charset_collate};"
		);
	}
}
