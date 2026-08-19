<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.4 Step 23. The customer dashboard's "علاقه‌مندی‌ها" (wishlist) nav item
 * has existed as a `ready: false` placeholder since the app-shell's own
 * dashboard scaffolding — this table is the first real data backing it.
 *
 * `provider_id` is the bc_professional/bc_business CPT post id, matching
 * every other provider reference in this codebase (wp_bc_bookings.provider_id,
 * wp_bc_provider_index.provider_id) -- never a WP user id. No FK to
 * wp_posts, same cross-plugin-activation-order reasoning as every other
 * table here. `UNIQUE(customer_id, provider_id)` is the real idempotency
 * guard for "add to wishlist" -- a repeated add is a harmless no-op, never
 * a duplicate row, matching this codebase's own INSERT IGNORE convention.
 */
final class CreateWishlistTable implements Migration {

	public function id(): string {
		return '2026_08_19_create_wishlist_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_wishlist_items (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				customer_id BIGINT UNSIGNED NOT NULL,
				provider_id BIGINT UNSIGNED NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY customer_provider (customer_id, provider_id),
				KEY customer_lookup (customer_id, created_at)
			) {$charset_collate};"
		);
	}
}
