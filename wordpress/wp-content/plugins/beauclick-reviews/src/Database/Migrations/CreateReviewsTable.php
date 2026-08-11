<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * `booking_id` is the "verified booking indicator" from the design
 * README, enforced here at the data layer (UNIQUE — one review per
 * booking) and again in ReviewService::create() (the booking must belong
 * to the author and be status='completed') — never just a UI badge. No DB
 * FK to beauclick-booking's table, same cross-plugin/activation-order
 * reasoning as every other module.
 */
final class CreateReviewsTable implements Migration {

	public function id(): string {
		return '2026_08_11_create_reviews_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_reviews';
		$charset_collate = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				author_id BIGINT UNSIGNED NOT NULL,
				target_type VARCHAR(20) NOT NULL DEFAULT 'provider',
				target_id BIGINT UNSIGNED NOT NULL,
				booking_id BIGINT UNSIGNED NOT NULL,
				rating TINYINT UNSIGNED NOT NULL,
				body TEXT NULL,
				images LONGTEXT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'approved',
				response TEXT NULL,
				response_at DATETIME NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY booking_id (booking_id),
				KEY target (target_type, target_id, status)
			) {$charset_collate};"
		);
	}
}
