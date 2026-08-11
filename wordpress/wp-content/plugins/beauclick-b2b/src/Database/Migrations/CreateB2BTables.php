<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * "B2B buyer" is deliberately not a WordPress role (architecture doc §9) —
 * it's any user with an approved row here. Approval is a data fact checked
 * at the point of use (pricing display, quote creation), not synced onto a
 * capability, so flipping approval never needs a role/capability rewrite.
 *
 * Tier pricing and quotes reference wp_posts (WooCommerce product IDs) by
 * plain indexed column, no FK — same cross-plugin-activation-order
 * reasoning as every other module's tables.
 */
final class CreateB2BTables implements Migration {

	public function id(): string {
		return '2026_08_11_create_b2b_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_business_accounts (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				business_name VARCHAR(191) NOT NULL,
				business_license VARCHAR(191) NULL,
				contact_phone VARCHAR(32) NULL,
				approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
				rejection_reason VARCHAR(255) NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_id (user_id),
				KEY approval_status (approval_status)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_b2b_price_tiers (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				product_id BIGINT UNSIGNED NOT NULL,
				min_qty INT UNSIGNED NOT NULL,
				max_qty INT UNSIGNED NULL,
				price BIGINT UNSIGNED NOT NULL,
				is_recommended TINYINT(1) NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY product_qty (product_id, min_qty)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_quotes (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				business_account_id BIGINT UNSIGNED NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'requested',
				items LONGTEXT NOT NULL,
				quoted_total BIGINT UNSIGNED NULL,
				wc_order_id BIGINT UNSIGNED NULL,
				expires_at DATETIME NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY business_account_id (business_account_id, status)
			) {$charset_collate};"
		);
	}
}
