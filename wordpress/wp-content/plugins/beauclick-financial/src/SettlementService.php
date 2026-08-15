<?php
declare( strict_types=1 );

namespace BeauClick\Financial;

/**
 * Sole owner of `wp_bc_settlement_batches`/`wp_bc_settlement_items`. A
 * settlement is a RECORD that a real, external payment already happened
 * (task §20) -- this class never moves money, never calls a gateway/bank
 * API, and never talks to `LedgerService`'s own write methods (settlement
 * only ever reads receivable facts `LedgerService`/this class's own
 * `outstanding_for_order()` compute, it never mutates `wp_bc_ledger_entries`).
 *
 * Phase 1 settlement model, explicitly decided per task §21: an admin
 * settles one or more SPECIFIC orders, each in FULL (its exact current
 * outstanding amount, computed by the system -- never a free-typed amount
 * an admin could fat-finger to not match any real financial fact). Not
 * lump-sum-only (which would make `wp_bc_settlement_items`' own
 * "which orders does this cover" traceability impossible), not arbitrary
 * partial-per-order amounts either (real complexity with no evidenced
 * Phase 1 need) -- the middle ground the task itself invited.
 */
final class SettlementService {

	public const STATUS_RECORDED = 'recorded';
	public const STATUS_REVERSED = 'reversed';

	public function __construct( private readonly LedgerService $ledger = new LedgerService() ) {}

	/** Current outstanding (receivable net minus already-settled, from non-reversed settlements) for one order. Can be negative if a refund landed after full settlement -- an honest, visible fact, never silently corrected here. */
	public function outstanding_for_order( int $order_id ): int {
		global $wpdb;
		$receivable_net = $this->ledger->order_receivable_net( $order_id );
		$settled        = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(SUM(si.amount), 0)
				 FROM {$wpdb->prefix}bc_settlement_items si
				 INNER JOIN {$wpdb->prefix}bc_settlement_batches sb ON sb.id = si.settlement_id
				 WHERE si.order_id = %d AND sb.status = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$order_id,
				self::STATUS_RECORDED
			)
		);
		return $receivable_net - $settled;
	}

	/** @return list<array{orderId:int, outstanding:int}> Only orders with a genuinely positive outstanding amount -- what an admin can actually select to settle. */
	public function outstanding_orders_for_party( string $party_type, int $party_id ): array {
		$orders = [];
		foreach ( $this->ledger->order_ids_for_party( $party_type, $party_id ) as $order_id ) {
			$outstanding = $this->outstanding_for_order( $order_id );
			if ( $outstanding > 0 ) {
				$orders[] = [ 'orderId' => $order_id, 'outstanding' => $outstanding ];
			}
		}
		return $orders;
	}

	/** @return array{receivableNet:int, settled:int, outstanding:int} */
	public function party_summary( string $party_type, int $party_id ): array {
		global $wpdb;
		$receivable_net = $this->ledger->party_receivable_net( $party_type, $party_id );
		$settled        = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(SUM(amount), 0) FROM {$wpdb->prefix}bc_settlement_batches WHERE party_type = %s AND party_id = %d AND status = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$party_type,
				$party_id,
				self::STATUS_RECORDED
			)
		);
		return [ 'receivableNet' => $receivable_net, 'settled' => $settled, 'outstanding' => $receivable_net - $settled ];
	}

	/**
	 * @param list<int> $order_ids
	 * @return array{id:int}|string New settlement id on success, a Persian error message on failure.
	 */
	public function create_settlement( string $party_type, int $party_id, array $order_ids, ?string $method, ?string $reference, ?string $note, int $actor_id ) {
		if ( ! in_array( $party_type, [ LedgerService::PARTY_PROFESSIONAL, LedgerService::PARTY_BUSINESS ], true ) ) {
			return 'نوع طرف حساب نامعتبر است.';
		}
		if ( ! $order_ids ) {
			return 'حداقل یک سفارش باید انتخاب شود.';
		}

		// Re-checked fresh, right before writing -- the real guard against
		// settling an order twice or above its outstanding amount, not the
		// admin UI's own (advisory only) checkbox list.
		$items = [];
		$total = 0;
		foreach ( array_unique( $order_ids ) as $order_id ) {
			$outstanding = $this->outstanding_for_order( $order_id );
			if ( $outstanding <= 0 ) {
				return sprintf( 'سفارش #%d مبلغ باقی‌مانده‌ای برای تسویه ندارد.', $order_id );
			}
			// Ownership re-check: this order's receivable must genuinely
			// belong to the party being settled -- never trust the caller's
			// own order_ids list alone.
			if ( ! in_array( $order_id, $this->ledger->order_ids_for_party( $party_type, $party_id ), true ) ) {
				return sprintf( 'سفارش #%d متعلق به این طرف حساب نیست.', $order_id );
			}
			$items[] = [ 'orderId' => $order_id, 'amount' => $outstanding ];
			$total  += $outstanding;
		}

		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_settlement_batches',
			[
				'party_type' => $party_type,
				'party_id'   => $party_id,
				'amount'     => $total,
				'currency'   => 'IRT',
				'method'     => $method,
				'reference'  => $reference,
				'note'       => $note,
				'status'     => self::STATUS_RECORDED,
				'created_by' => $actor_id,
				'created_at' => $now,
			],
			[ '%s', '%d', '%d', '%s', '%s', '%s', '%s', '%s', '%d', '%s' ]
		);
		$settlement_id = (int) $wpdb->insert_id;

		foreach ( $items as $item ) {
			$wpdb->query(
				$wpdb->prepare(
					"INSERT IGNORE INTO {$wpdb->prefix}bc_settlement_items (settlement_id, order_id, amount, created_at) VALUES (%d, %d, %d, %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					$settlement_id,
					$item['orderId'],
					$item['amount'],
					$now
				)
			);
		}

		return [ 'id' => $settlement_id ];
	}

	/** @return true|string */
	public function reverse_settlement( int $settlement_id, int $actor_id, string $reason ) {
		$settlement = $this->find( $settlement_id );
		if ( ! $settlement ) {
			return 'تسویه پیدا نشد.';
		}
		if ( self::STATUS_REVERSED === $settlement['status'] ) {
			return 'این تسویه قبلاً برگشت خورده است.';
		}

		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_settlement_batches',
			[
				'status'          => self::STATUS_REVERSED,
				'reversed_by'     => $actor_id,
				'reversed_at'     => current_time( 'mysql' ),
				'reversed_reason' => $reason,
			],
			[ 'id' => $settlement_id ],
			[ '%s', '%d', '%s', '%s' ],
			[ '%d' ]
		);

		return true;
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_settlement_batches WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	/** @return list<array<string, mixed>> */
	public function items_for( int $settlement_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_settlement_items WHERE settlement_id = %d ORDER BY id ASC", $settlement_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ) => [ 'id' => (int) $r['id'], 'orderId' => (int) $r['order_id'], 'amount' => (int) $r['amount'] ],
			$rows ?: []
		);
	}

	/** @return list<array<string, mixed>> Most recent first. */
	public function for_party( string $party_type, int $party_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_settlement_batches WHERE party_type = %s AND party_id = %d ORDER BY id DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$party_type,
				$party_id
			),
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/** @return list<array<string, mixed>> Most recent first, bounded. */
	public function recent( int $limit = 50 ): array {
		global $wpdb;
		$limit = max( 1, min( 200, $limit ) );
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_settlement_batches ORDER BY id DESC LIMIT %d", $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/** @param array<string, mixed> $row @return array<string, mixed> */
	private function format( array $row ): array {
		return [
			'id'             => (int) $row['id'],
			'partyType'      => $row['party_type'],
			'partyId'        => (int) $row['party_id'],
			'amount'         => (int) $row['amount'],
			'currency'       => $row['currency'],
			'method'         => $row['method'],
			'reference'      => $row['reference'],
			'note'           => $row['note'],
			'status'         => $row['status'],
			'createdBy'      => (int) $row['created_by'],
			'createdAt'      => $row['created_at'],
			'reversedBy'     => null !== $row['reversed_by'] ? (int) $row['reversed_by'] : null,
			'reversedAt'     => $row['reversed_at'],
			'reversedReason' => $row['reversed_reason'],
		];
	}
}
