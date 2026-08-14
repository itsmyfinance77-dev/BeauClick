<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Append-only administrative audit trail — the general-purpose sibling of
 * beauclick-marketplace's own wp_bc_verification_history (V2.1 Step 8),
 * generalized per V2.2 Step 13 (ADMIN-02) to cover admin actions outside
 * verification: B2B account approval/rejection, review moderation, loyalty
 * tier/plan/benefit configuration, and membership grant/cancel.
 *
 * Deliberately a SEPARATE table from wp_bc_events. That table is a
 * product/analytics signal log (booking, review, AI, search events feeding
 * ranking and the Analytics dashboard) — mixing private administrative
 * actions into it would either leak them into analytics aggregates that
 * should stay product-behavior-only, or force every analytics query to
 * filter admin noise back out. This class exists specifically so that never
 * has to happen (V2.2 Step 13 task instruction: "distinguish Analytics
 * events from Administrative audit events").
 *
 * No update()/delete() method exists here by design — once written, a row
 * is never modified, matching the exact discipline
 * VerificationService::transition() already established for its own
 * history table. Ordinary admin capabilities (bc_manage_platform etc.)
 * never grant write access to this table directly; only this class's
 * record() method, called from the specific admin action being audited,
 * ever inserts a row.
 */
final class AuditLogger {

	/**
	 * @param array<string, mixed>|null $previous_state
	 * @param array<string, mixed>|null $new_state
	 */
	public function record(
		string $action_type,
		string $entity_type,
		int $entity_id,
		?int $actor_id,
		?array $previous_state = null,
		?array $new_state = null,
		?string $reason = null
	): void {
		global $wpdb;

		$wpdb->insert(
			$wpdb->prefix . 'bc_admin_audit_log',
			[
				'action_type'    => $action_type,
				'entity_type'    => $entity_type,
				'entity_id'      => $entity_id,
				'actor_user_id'  => $actor_id,
				'previous_state' => null !== $previous_state ? wp_json_encode( $previous_state ) : null,
				'new_state'      => null !== $new_state ? wp_json_encode( $new_state ) : null,
				'reason'         => $reason,
				'created_at'     => current_time( 'mysql' ),
			],
			[ '%s', '%s', '%d', '%d', '%s', '%s', '%s', '%s' ]
		);
	}

	/**
	 * Bounded, unfiltered, most-recent-first — used by the Overview page's
	 * "recent admin actions" card.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function recent( int $limit = 20 ): array {
		global $wpdb;
		$limit = max( 1, min( 200, $limit ) );

		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT %d", $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		return $rows ?: [];
	}

	/**
	 * @param array{action_type?:string,entity_type?:string,from?:string,to?:string} $filters
	 * @return array{items: array<int, array<string, mixed>>, total: int}
	 */
	public function query( array $filters, int $page, int $per_page ): array {
		global $wpdb;
		$page     = max( 1, $page );
		$per_page = max( 1, min( 100, $per_page ) );

		$where  = [ '1=1' ];
		$values = [];

		if ( ! empty( $filters['action_type'] ) ) {
			$where[]  = 'action_type = %s';
			$values[] = $filters['action_type'];
		}
		if ( ! empty( $filters['entity_type'] ) ) {
			$where[]  = 'entity_type = %s';
			$values[] = $filters['entity_type'];
		}
		if ( ! empty( $filters['from'] ) ) {
			$where[]  = 'created_at >= %s';
			$values[] = $filters['from'] . ' 00:00:00';
		}
		if ( ! empty( $filters['to'] ) ) {
			$where[]  = 'created_at <= %s';
			$values[] = $filters['to'] . ' 23:59:59';
		}

		$where_sql = implode( ' AND ', $where );
		$table     = $wpdb->prefix . 'bc_admin_audit_log';

		$total_sql = "SELECT COUNT(*) FROM {$table} WHERE {$where_sql}"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$total     = (int) ( $values ? $wpdb->get_var( $wpdb->prepare( $total_sql, $values ) ) : $wpdb->get_var( $total_sql ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$offset      = ( $page - 1 ) * $per_page;
		$list_sql    = "SELECT * FROM {$table} WHERE {$where_sql} ORDER BY id DESC LIMIT %d OFFSET %d"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$list_values = array_merge( $values, [ $per_page, $offset ] );
		$items       = $wpdb->get_results( $wpdb->prepare( $list_sql, $list_values ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		return [
			'items' => $items ?: [],
			'total' => $total,
		];
	}
}
