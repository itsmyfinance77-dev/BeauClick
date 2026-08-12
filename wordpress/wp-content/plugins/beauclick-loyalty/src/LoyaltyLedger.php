<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty;

/**
 * The real (not fake) part of the loyalty stub — append-only ledger with
 * an accurate running balance. What's deliberately NOT here yet is any
 * rule deciding when to call award() (e.g. "+10 points on booking
 * completion") — that, plus a redemption flow and account UI, is future
 * work once the business defines the actual point values/rules.
 */
final class LoyaltyLedger {

	/** Points may be negative (a future redemption) — reason/reference_type/id are freeform, same shape as EventLogger's event log. */
	public function award( int $user_id, int $points, string $reason, ?string $reference_type = null, ?int $reference_id = null ): void {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_loyalty_points',
			[
				'user_id'         => $user_id,
				'points'          => $points,
				'reason'          => $reason,
				'reference_type'  => $reference_type,
				'reference_id'    => $reference_id,
				'created_at'      => current_time( 'mysql' ),
			],
			[ '%d', '%d', '%s', '%s', '%d', '%s' ]
		);
	}

	public function balance( int $user_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE(SUM(points), 0) FROM {$wpdb->prefix}bc_loyalty_points WHERE user_id = %d", $user_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/**
	 * V2.1 Step 9 — tier qualification uses LIFETIME EARNED points (the sum
	 * of every positive award ever made), never the spendable `balance()`.
	 * A future redemption (a negative row) must never demote a customer's
	 * tier -- "how much have you earned" is the qualification question,
	 * "how much can you still spend" is a completely different one. This is
	 * a deliberate, documented choice (not a silently-invented business
	 * rule): the alternative models the task raised -- rolling-period or
	 * annual re-qualification -- are NOT implemented here and remain
	 * NEEDS_BUSINESS_DECISION; see the Step 9 architecture notes. Additive
	 * to LoyaltyLedger, not a second balance -- still one query against the
	 * same, single ledger table.
	 */
	public function lifetime_earned( int $user_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COALESCE(SUM(points), 0) FROM {$wpdb->prefix}bc_loyalty_points WHERE user_id = %d AND points > 0", $user_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
	}

	/**
	 * V2.0 Step 1's idempotency check: whether a given (reference_type,
	 * reference_id, reason) triple has already been awarded, so a caller
	 * can skip re-awarding before ever attempting the insert. This is the
	 * fast-path half of the guarantee — the hard half is the UNIQUE index
	 * added by AddLoyaltyReferenceUniqueIndex, which makes a genuine
	 * concurrent double-award a DB-level impossibility even if two
	 * requests both pass this check before either inserts.
	 */
	public function has_awarded( string $reference_type, int $reference_id, string $reason ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_loyalty_points WHERE reference_type = %s AND reference_id = %d AND reason = %s LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$reference_type,
				$reference_id,
				$reason
			)
		);
	}

	/** @return array<int, array{points: int, reason: string, createdAt: string}> */
	public function history( int $user_id, int $limit = 50 ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT points, reason, created_at FROM {$wpdb->prefix}bc_loyalty_points WHERE user_id = %d ORDER BY id DESC LIMIT %d", $user_id, $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ) => [ 'points' => (int) $r['points'], 'reason' => $r['reason'], 'createdAt' => $r['created_at'] ],
			$rows ?: []
		);
	}
}
