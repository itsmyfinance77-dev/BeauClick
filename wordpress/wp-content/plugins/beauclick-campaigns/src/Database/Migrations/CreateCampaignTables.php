<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * Two tables, deliberately not three — the task's own suggested
 * Campaign/Campaign Rule/Campaign Target/Campaign Usage shape is collapsed
 * to Campaign (rules/targets are a small, fixed set of nullable columns, not
 * a flexible rule engine nobody asked for) + Campaign Usage (the idempotency/
 * audit ledger a real promotion mechanism needs). Mirrors
 * `wp_bc_loyalty_tiers`/`wp_bc_loyalty_benefits`' own "admin-configured,
 * never hardcoded" convention and `wp_bc_referrals`' own
 * UNIQUE-key-is-the-real-guarantee idempotency discipline.
 *
 * `wp_bc_campaigns` — one row per promotion. `service_id`/`provider_id` NULL
 * means "any" (wildcard), not "none". `status` is the only stored lifecycle
 * state (draft/active/paused/archived); whether a campaign is currently
 * *in its date window* is derived at read time from `starts_at`/`ends_at`,
 * never a separate stored "expired" status — same "derive, don't cache"
 * discipline `TierService::for_points()` already established for loyalty
 * tiers.
 *
 * `wp_bc_campaign_usages` — one row per booking a campaign discount was
 * actually applied to. `UNIQUE KEY booking_id` is the real idempotency
 * guarantee (a retried fee-application attempt for the same booking is
 * rejected by the database itself, not just application logic that could be
 * raced) — the exact same discipline `wp_bc_referrals`' own
 * `UNIQUE(referee_user_id)` already established for this codebase.
 * `status` (`applied`/`released`) lets a cancelled/failed/refunded order's
 * usage stop counting against `usage_limit_total`/`usage_limit_per_customer`
 * without ever deleting the audit row — an abandoned booking hold doesn't
 * unfairly cost the customer their shot at a limited campaign, but the
 * campaign's own cap still only reflects genuinely live usage.
 */
final class CreateCampaignTables implements Migration {

	public function id(): string {
		return '2026_08_15_create_campaign_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_campaigns (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				name VARCHAR(191) NOT NULL,
				discount_type VARCHAR(20) NOT NULL,
				discount_value INT UNSIGNED NOT NULL,
				max_discount_amount INT UNSIGNED NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'draft',
				starts_at DATETIME NULL,
				ends_at DATETIME NULL,
				service_id BIGINT UNSIGNED NULL,
				provider_id BIGINT UNSIGNED NULL,
				customer_scope VARCHAR(20) NOT NULL DEFAULT 'all',
				min_order_value INT UNSIGNED NULL,
				usage_limit_total INT UNSIGNED NULL,
				usage_limit_per_customer INT UNSIGNED NULL,
				created_by BIGINT UNSIGNED NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY status_dates (status, starts_at, ends_at),
				KEY service_id (service_id),
				KEY provider_id (provider_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_campaign_usages (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				campaign_id BIGINT UNSIGNED NOT NULL,
				booking_id BIGINT UNSIGNED NOT NULL,
				order_id BIGINT UNSIGNED NOT NULL,
				customer_id BIGINT UNSIGNED NOT NULL,
				discount_amount INT UNSIGNED NOT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'applied',
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY booking_id (booking_id),
				KEY campaign_status (campaign_id, status),
				KEY customer_campaign (campaign_id, customer_id, status),
				KEY order_id (order_id)
			) {$charset_collate};"
		);
	}
}
