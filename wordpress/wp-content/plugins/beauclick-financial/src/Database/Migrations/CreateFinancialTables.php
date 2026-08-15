<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.3 Step 18. Three tables, deliberately not the full four the task's own
 * candidate list named — "Financial Entry" is not a separate table from
 * "Financial Ledger": each row of `wp_bc_ledger_entries` already IS one
 * entry, so a second table for the same concept would just be redundant.
 *
 * `wp_bc_ledger_entries` — append-only. Deliberately does NOT store gross/
 * discount/subtotal — those already exist forever, unmodified, on the real
 * WooCommerce order/order-items (task §6: "the ledger should NOT
 * independently recalculate historical order totals... explain the
 * financial history, not replace WooCommerce as the order system"). This
 * table only records the TWO facts that exist nowhere else: the platform's
 * `commission` cut and the professional/business's `receivable` cut of a
 * booking order's real, already-discounted `WC_Order::get_total()` — plus
 * the negative reversal counterpart of each when a refund happens. Every
 * row's own `commission_rate`/`basis` are captured at write time, not
 * looked up live, so a later change to the platform's commission
 * configuration can never silently rewrite the financial meaning of a past
 * transaction.
 *
 * `UNIQUE KEY entry_once (entry_type, reference_type, reference_id)` is the
 * real idempotency guarantee (mirrors `wp_bc_campaign_usages`' own
 * `UNIQUE(booking_id)` discipline from V2.3 Step 17) — a retried
 * `woocommerce_payment_complete`/`woocommerce_order_refunded` fire for the
 * same order/refund can never double-record commission or receivable.
 *
 * Scope decision, explained in full in the architecture plan: this table
 * only ever gets rows for BOOKING orders (an order carrying `_bc_booking_id`
 * meta) — a Shop/B2B-wholesale purchase is a direct platform sale with no
 * professional/business party to split revenue with (confirmed by reading
 * `MyAnalyticsController::b2b_section()`'s own "gross order value, never
 * earnings" framing — B2B is a wholesale BUYER account, not a marketplace
 * SELLER), so there is no receivable to record for those and WooCommerce's
 * own order data remains fully sufficient on its own.
 *
 * `wp_bc_settlement_batches`/`wp_bc_settlement_items` — a settlement is an
 * admin-recorded FACT that a real, external payment already happened (task
 * §20: "the actual external transfer is not performed by BeauClick"), never
 * a payment instruction. `settlement_items` itemizes by `order_id` so
 * "why is this party's outstanding balance X" (task §31) is always
 * traceable to specific orders, not a single opaque lump sum.
 */
final class CreateFinancialTables implements Migration {

	public function id(): string {
		return '2026_08_15_create_financial_tables';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$charset_collate = $wpdb->get_charset_collate();
		$prefix          = $wpdb->prefix;

		dbDelta(
			"CREATE TABLE {$prefix}bc_ledger_entries (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				order_id BIGINT UNSIGNED NOT NULL,
				booking_id BIGINT UNSIGNED NOT NULL,
				party_type VARCHAR(20) NOT NULL,
				party_id BIGINT UNSIGNED NULL,
				entry_type VARCHAR(20) NOT NULL,
				amount INT NOT NULL,
				currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
				basis VARCHAR(30) NOT NULL,
				commission_rate INT NOT NULL,
				reference_type VARCHAR(20) NOT NULL,
				reference_id BIGINT UNSIGNED NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY entry_once (entry_type, reference_type, reference_id),
				KEY order_id (order_id),
				KEY party (party_type, party_id)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_settlement_batches (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				party_type VARCHAR(20) NOT NULL,
				party_id BIGINT UNSIGNED NOT NULL,
				amount INT NOT NULL,
				currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
				method VARCHAR(191) NULL,
				reference VARCHAR(191) NULL,
				note TEXT NULL,
				status VARCHAR(20) NOT NULL DEFAULT 'recorded',
				created_by BIGINT UNSIGNED NOT NULL,
				created_at DATETIME NOT NULL,
				reversed_by BIGINT UNSIGNED NULL,
				reversed_at DATETIME NULL,
				reversed_reason VARCHAR(255) NULL,
				PRIMARY KEY  (id),
				KEY party_status (party_type, party_id, status)
			) {$charset_collate};"
		);

		dbDelta(
			"CREATE TABLE {$prefix}bc_settlement_items (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				settlement_id BIGINT UNSIGNED NOT NULL,
				order_id BIGINT UNSIGNED NOT NULL,
				amount INT NOT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY settlement_order (settlement_id, order_id),
				KEY order_id (order_id)
			) {$charset_collate};"
		);
	}
}
