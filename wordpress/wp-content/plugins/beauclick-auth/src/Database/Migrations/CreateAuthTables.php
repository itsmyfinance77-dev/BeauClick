<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Three tables, each owning exactly one concern:
 *
 * wp_bc_otp_requests -- one row per OTP code issued. Never stores the
 * plaintext code (only an HMAC-SHA256 digest keyed off wp_salt('auth'), the
 * same salt WordPress's own auth-cookie signing already trusts -- no new
 * cryptographic infrastructure). attempts/max_attempts implement the
 * brute-force lockout; expires_at/consumed_at implement expiry and replay
 * prevention. requester_user_id is only set for the change-phone purpose
 * (login-required), NULL for login_or_register (no account may exist yet).
 *
 * wp_bc_phone_index -- the one authoritative "which WP user does this
 * canonical phone number belong to" table. Deliberately separate from
 * WooCommerce's own _billing_phone usermeta (see PhoneNormalizer/
 * AccountResolver's own docblocks): _billing_phone is free-text, unnormalized,
 * and never enforced unique; this table's UNIQUE KEY is the real database-level
 * guarantee that two accounts can never share a verified canonical phone
 * going forward, matching this codebase's own established "make a real
 * invariant a real constraint" discipline (see Loyalty's reference_once
 * index from V2.0 Step 1). One row per user, written only after that user
 * has actually verified ownership of the number via a completed OTP flow.
 *
 * wp_bc_phone_conflicts -- an explicit, inspectable record of the one case
 * this codebase's own standing rule ("do not silently merge users") forbids
 * resolving automatically: an existing pre-auth-system account's normalized
 * _billing_phone colliding with another existing account's. Detected, never
 * silently picked between -- see AccountResolver::find_or_create_for_phone().
 *
 * No cross-plugin foreign keys, matching every other table in this codebase.
 */
final class CreateAuthTables implements Migration {

	public function id(): string {
		return '2026_08_12_create_auth_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix           = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_otp_requests (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				phone_canonical VARCHAR(20) NOT NULL,
				purpose VARCHAR(20) NOT NULL,
				code_hash CHAR(64) NOT NULL,
				attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
				max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
				expires_at DATETIME NOT NULL,
				consumed_at DATETIME NULL,
				requester_user_id BIGINT UNSIGNED NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY phone_purpose (phone_canonical, purpose, created_at)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_phone_index (
				user_id BIGINT UNSIGNED NOT NULL,
				phone_canonical VARCHAR(20) NOT NULL,
				verified_at DATETIME NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (user_id),
				UNIQUE KEY phone_canonical (phone_canonical)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_phone_conflicts (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				phone_canonical VARCHAR(20) NOT NULL,
				candidate_user_ids TEXT NOT NULL,
				detected_at DATETIME NOT NULL,
				resolved_at DATETIME NULL,
				PRIMARY KEY  (id),
				KEY phone_canonical (phone_canonical)
			) {$charset_collate};"
		);
	}
}
