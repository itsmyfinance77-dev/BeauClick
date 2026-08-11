<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.0 Step 1: wires real callers onto the previously-dormant
 * LoyaltyLedger::award() (see EarningRules). The task's hard requirement —
 * points must never be awarded twice for the same eligible event — is
 * enforced at the database layer here, not just by an application-level
 * check, so a genuine race between two near-simultaneous calls (e.g. a
 * duplicated WooCommerce webhook) can't slip two rows past a check that
 * both happened to run before either had inserted.
 *
 * NULL-safe by design: MySQL/InnoDB treats each NULL as distinct under a
 * UNIQUE index, so rows with no reference (e.g. a future manual admin
 * adjustment or promotional bonus) are never blocked by this constraint —
 * only a true, non-null (reference_type, reference_id, reason) repeat is.
 *
 * A separate migration rather than editing CreateLoyaltyPointsTable — that
 * one already shipped and is recorded in the ledger; schema evolution is a
 * new migration, matching this project's own established convention (see
 * beauclick-booking's AddHoldExpiryColumns). The table has zero real rows
 * in any environment today (award() was never called before this), so
 * there's no pre-existing data this constraint could conflict with.
 */
final class AddLoyaltyReferenceUniqueIndex implements Migration {

	public function id(): string {
		return '2026_08_12_add_loyalty_reference_unique_index';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_loyalty_points';
		$charset_collate = $wpdb->get_charset_collate();

		// dbDelta diffs the full CREATE TABLE against the live schema and
		// issues the necessary ALTER TABLE ADD INDEX statement — this is its
		// documented upgrade path, not a re-create.
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
				KEY user_id (user_id, created_at),
				UNIQUE KEY reference_once (reference_type, reference_id, reason)
			) {$charset_collate};"
		);
	}
}
