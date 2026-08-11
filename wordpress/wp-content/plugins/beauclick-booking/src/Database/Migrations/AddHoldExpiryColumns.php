<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * A booking created before payment must not lock its slot forever if the
 * customer abandons checkout. Slots gain a real "held" state (distinct from
 * "open" and permanently "booked") with an expiry timestamp; bookings gain
 * a matching expires_at so BookingService::expire_stale_holds() can find
 * abandoned ones without joining the slots table. A separate migration
 * rather than editing CreateBookingTables — that one already shipped and
 * is recorded in the ledger; schema evolution is a new migration, never a
 * rewrite of history.
 */
final class AddHoldExpiryColumns implements Migration {

	public function id(): string {
		return '2026_08_11_add_hold_expiry_columns';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		// dbDelta diffs the full CREATE TABLE against the live schema and
		// issues the necessary ALTER TABLE ADD COLUMN statements — this is
		// its documented upgrade path, not a re-create.
		dbDelta(
			"CREATE TABLE {$prefix}bc_availability_slots (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				service_id BIGINT UNSIGNED NULL,
				start_at DATETIME NOT NULL,
				end_at DATETIME NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'open',
				held_until DATETIME NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY provider_lookup (provider_id, start_at, status),
				KEY status (status),
				KEY held_until (held_until)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_bookings (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				customer_id BIGINT UNSIGNED NOT NULL,
				provider_id BIGINT UNSIGNED NOT NULL,
				service_id BIGINT UNSIGNED NULL,
				slot_id BIGINT UNSIGNED NOT NULL,
				slot_start DATETIME NOT NULL,
				slot_end DATETIME NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				expires_at DATETIME NULL,
				wc_order_id BIGINT UNSIGNED NULL,
				payment_status VARCHAR(20) NULL,
				cancelled_reason VARCHAR(255) NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY customer_id (customer_id, status),
				KEY provider_id (provider_id, status),
				KEY slot_id (slot_id),
				KEY wc_order_id (wc_order_id),
				KEY expires_at (expires_at)
			) {$charset_collate};"
		);
	}
}
