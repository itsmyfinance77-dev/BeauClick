<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Availability is stored as concrete, already-materialized slot rows
 * (start_at/end_at), not a recurrence rule evaluated at read time —
 * architecture doc §8's "materialize concrete slots for a rolling window"
 * recommendation, simplified for this phase to direct creation via the
 * professional's own REST call rather than a cron-driven recurrence
 * engine (no recurring-pattern UI yet — noted as a later refinement, not
 * a shortcut that breaks anything: slots are real rows either way).
 *
 * No FK constraints to beauclick-marketplace's provider posts or
 * WooCommerce's orders — same cross-plugin-activation-order reasoning as
 * every other module (architecture doc §8 note).
 */
final class CreateBookingTables implements Migration {

	public function id(): string {
		return '2026_08_11_create_booking_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_availability_slots (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				provider_id BIGINT UNSIGNED NOT NULL,
				service_id BIGINT UNSIGNED NULL,
				start_at DATETIME NOT NULL,
				end_at DATETIME NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'open',
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY provider_lookup (provider_id, start_at, status),
				KEY status (status)
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
				wc_order_id BIGINT UNSIGNED NULL,
				payment_status VARCHAR(20) NULL,
				cancelled_reason VARCHAR(255) NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY customer_id (customer_id, status),
				KEY provider_id (provider_id, status),
				KEY slot_id (slot_id),
				KEY wc_order_id (wc_order_id)
			) {$charset_collate};"
		);
	}
}
