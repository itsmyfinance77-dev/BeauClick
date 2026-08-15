<?php
declare( strict_types=1 );

namespace BeauClick\Financial;

/**
 * V2.3 Step 18 explicitly leaves the real commission percentage as
 * `NEEDS_BUSINESS_DECISION` — this class is the one place that provisional
 * number lives, in the exact same spirit as `beauclick-referral\ReferralConfig`'s
 * own documented-provisional constants: a real, working, filterable default
 * so the system is deterministic and testable today, never presented as a
 * final commercial policy.
 *
 * `basis()` is deliberately fixed to `net_customer_amount` (the real,
 * already-discounted `WC_Order::get_total()` a customer actually paid — the
 * amount platform and professional genuinely have to split) for this
 * step's own Phase 1, but every `wp_bc_ledger_entries` row stores its own
 * `basis` string at write time (see the migration's own docblock) — so a
 * future step could introduce a second basis without needing to touch or
 * reinterpret any historical row.
 */
final class CommissionConfig {

	public const DEFAULT_RATE_PERCENT = 15;
	public const BASIS                = 'net_customer_amount';

	/** Integer percent, 0-100. */
	public static function rate(): int {
		$stored = get_option( 'bc_financial_commission_rate', false );
		$rate   = false !== $stored ? (int) $stored : self::DEFAULT_RATE_PERCENT;

		/**
		 * @param int $rate Percent, 0-100.
		 */
		$rate = (int) apply_filters( 'beauclick/financial/commission_rate', $rate );
		return max( 0, min( 100, $rate ) );
	}

	public static function set_rate( int $rate ): void {
		update_option( 'bc_financial_commission_rate', max( 0, min( 100, $rate ) ) );
	}

	public static function basis(): string {
		return self::BASIS;
	}
}
