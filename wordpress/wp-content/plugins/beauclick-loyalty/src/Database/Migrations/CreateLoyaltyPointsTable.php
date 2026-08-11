<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Stub per architecture doc §13: the points ledger table + a real
 * award()/balance() seam (LoyaltyLedger) exist now so a future phase can
 * plug in point-awarding rules and a redemption UI without a schema
 * change — but no rule decides who earns points for what yet, and nothing
 * in booking/reviews/orders calls award() automatically. An append-only
 * ledger (not a single mutable balance column) so the full earn/redeem
 * history is never lost, matching the same audit-trail shape as wp_bc_events.
 */
final class CreateLoyaltyPointsTable implements Migration {

	public function id(): string {
		return '2026_08_11_create_loyalty_points_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_loyalty_points';
		$charset_collate = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				points INT NOT NULL,
				reason VARCHAR(64) NOT NULL,
				reference_type VARCHAR(32) NULL,
				reference_id BIGINT UNSIGNED NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY user_id (user_id, created_at)
			) {$charset_collate};"
		);
	}
}
