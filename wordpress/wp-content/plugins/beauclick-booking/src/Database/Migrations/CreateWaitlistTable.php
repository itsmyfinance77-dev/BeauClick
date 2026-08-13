<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.1 Step 10 (BOOK-06) — a deliberately small waitlist model, per the
 * task's own "do not force a giant schema if a smaller model is
 * sufficient" instruction. `provider_id` is the professional/business CPT
 * post id (matching `wp_bc_bookings`/`wp_bc_availability_slots`'s own
 * existing convention, confirmed against `DemoAvailabilitySeed` and
 * `MarketplaceController` before writing this), never a WP user id.
 *
 * No FK to `wp_posts`/`wp_bc_availability_slots` — same
 * cross-plugin-activation-order reasoning as every other table in this
 * codebase; validity is checked in `WaitlistService` at write time.
 * Duplicate-active-entry prevention is application-level (see
 * `WaitlistService::create()`), not a DB UNIQUE constraint — MySQL treats
 * every NULL as distinct under UNIQUE, which would silently let a customer
 * with no `service_id`/`preferred_date` preference create unlimited
 * duplicate rows if the constraint were relied on alone.
 */
final class CreateWaitlistTable implements Migration {

	public function id(): string {
		return '2026_08_13_create_waitlist_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_waitlist_entries (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				customer_id BIGINT UNSIGNED NOT NULL,
				provider_id BIGINT UNSIGNED NOT NULL,
				service_id BIGINT UNSIGNED NULL,
				preferred_date DATE NULL,
				preferred_time_start TIME NULL,
				preferred_time_end TIME NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'waiting',
				notified_at DATETIME NULL,
				expires_at DATETIME NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY customer_status (customer_id, status),
				KEY provider_matching (provider_id, status, service_id, preferred_date)
			) {$charset_collate};"
		);
	}
}
