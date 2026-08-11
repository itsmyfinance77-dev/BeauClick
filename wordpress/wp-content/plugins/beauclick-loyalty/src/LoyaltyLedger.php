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
