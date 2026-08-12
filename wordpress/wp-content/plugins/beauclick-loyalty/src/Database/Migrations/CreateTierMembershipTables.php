<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.1 Step 9 — four additive tables layered on top of the existing,
 * unchanged `wp_bc_loyalty_points` ledger (still the single source of
 * truth for earned/redeemed points and balance). Nothing here duplicates
 * it: a customer's CURRENT TIER is never stored — it's always computed at
 * read time from `TierService::for_points()` against the ledger's own
 * lifetime-earned sum, exactly the "prefer current state derived from
 * authoritative records + minimal persisted membership state" guidance.
 *
 * - `wp_bc_loyalty_tiers` — configurable tier definitions (threshold ->
 *   name), never hardcoded in PHP.
 * - `wp_bc_membership_plans` — configurable plan definitions; a plan may
 *   optionally link to a tier (auto-granted on qualification) or stand
 *   alone. `price`/`billing_period_days` are nullable and, where seeded,
 *   provisional-development values only — see this migration's own docblock
 *   and the Step 9 architecture notes for the NEEDS_BUSINESS_DECISION flag.
 * - `wp_bc_memberships` — one row per user (a user has at most one
 *   membership record; `UNIQUE KEY user_id`), holding real account STATE
 *   (active/expired/cancelled), not a ledger. Activation/expiry/cancellation
 *   events are logged through the existing `EventLogger` (`wp_bc_events`)
 *   for auditability rather than inventing a fifth table.
 * - `wp_bc_loyalty_benefits` — polymorphic (`source_type`/`source_id`,
 *   matching the same reference_type/reference_id convention already used
 *   by `wp_bc_events`/`wp_bc_loyalty_points`) so a benefit can belong to
 *   either a tier or a membership plan without two near-identical tables.
 */
final class CreateTierMembershipTables implements Migration {

	public function id(): string {
		return '2026_08_13_create_tier_membership_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_loyalty_tiers (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				slug VARCHAR(64) NOT NULL,
				name VARCHAR(191) NOT NULL,
				threshold_points INT UNSIGNED NOT NULL DEFAULT 0,
				sort_order INT NOT NULL DEFAULT 0,
				is_active TINYINT(1) NOT NULL DEFAULT 1,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY active_threshold (is_active, threshold_points)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_membership_plans (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				slug VARCHAR(64) NOT NULL,
				name VARCHAR(191) NOT NULL,
				tier_id BIGINT UNSIGNED NULL,
				is_paid TINYINT(1) NOT NULL DEFAULT 0,
				price INT UNSIGNED NULL,
				billing_period_days INT UNSIGNED NULL,
				is_active TINYINT(1) NOT NULL DEFAULT 1,
				sort_order INT NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY slug (slug),
				KEY tier_id (tier_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_memberships (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				plan_id BIGINT UNSIGNED NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'active',
				activation_source VARCHAR(20) NOT NULL DEFAULT 'manual',
				started_at DATETIME NOT NULL,
				expires_at DATETIME NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_id (user_id),
				KEY plan_id (plan_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_loyalty_benefits (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				source_type VARCHAR(20) NOT NULL,
				source_id BIGINT UNSIGNED NOT NULL,
				benefit_type VARCHAR(30) NOT NULL,
				label VARCHAR(191) NOT NULL,
				config TEXT NULL,
				is_active TINYINT(1) NOT NULL DEFAULT 1,
				sort_order INT NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY source (source_type, source_id, is_active)
			) {$charset_collate};"
		);
	}
}
