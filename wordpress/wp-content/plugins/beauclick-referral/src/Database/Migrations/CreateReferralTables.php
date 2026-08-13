<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Two tables, deliberately separate concerns:
 *
 * `wp_bc_referral_codes` — each user has at most ONE stable, permanent
 * code (UNIQUE user_id), generated lazily on first "get my code" call, not
 * pre-generated for every user on activation.
 *
 * `wp_bc_referrals` — one row per successful referred SIGNUP, not per
 * share/click (a code can be shared many times; only a real registration
 * creates a row here). `UNIQUE (referee_user_id)` is the hard anti-abuse
 * guarantee: a given account can only ever be someone's referee once,
 * ever — the DB itself rejects a second attribution attempt for the same
 * user, not just application logic that could be raced.
 */
final class CreateReferralTables implements Migration {

	public function id(): string {
		return '2026_08_14_create_referral_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_referral_codes (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				code VARCHAR(16) NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_id (user_id),
				UNIQUE KEY code (code)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_referrals (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				referrer_user_id BIGINT UNSIGNED NOT NULL,
				referee_user_id BIGINT UNSIGNED NOT NULL,
				code_used VARCHAR(16) NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'pending',
				created_at DATETIME NOT NULL,
				qualified_at DATETIME NULL,
				rewarded_at DATETIME NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY referee_user_id (referee_user_id),
				KEY referrer_status (referrer_user_id, status)
			) {$charset_collate};"
		);
	}
}
