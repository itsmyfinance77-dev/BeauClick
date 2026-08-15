<?php
declare( strict_types=1 );

namespace BeauClick\Financial;

/**
 * Sole owner of `wp_bc_ledger_entries` — every read/write goes through this
 * class, matching the one-service-per-table-group convention already
 * established throughout this codebase (`CampaignService`, `TierService`,
 * `ReferralService`). Records commission/receivable facts computed from an
 * already-authoritative `WC_Order`/`WC_Order_Refund` object handed to it by
 * a `Recording\*` listener — this class never queries WooCommerce itself,
 * it only ever persists numbers it was given.
 */
final class LedgerService {

	public const TYPE_COMMISSION = 'commission';
	public const TYPE_RECEIVABLE = 'receivable';

	public const REF_PAYMENT = 'order_payment';
	public const REF_REFUND  = 'order_refund';

	public const PARTY_PLATFORM     = 'platform';
	public const PARTY_PROFESSIONAL = 'professional';
	public const PARTY_BUSINESS     = 'business';

	/**
	 * Records the commission + receivable pair for a booking order's real
	 * payment. `INSERT IGNORE` against `UNIQUE(entry_type, reference_type,
	 * reference_id)` is the actual idempotency guarantee — a retried
	 * `woocommerce_payment_complete` fire for the same order can never
	 * double-record either row, no preceding SELECT needed (same
	 * insert-first discipline `CampaignService::record_usage()` already
	 * established in V2.3 Step 17).
	 *
	 * @return bool True if this call newly recorded the pair (false if
	 *              already recorded — not an error, a normal idempotent no-op).
	 */
	public function record_payment( int $order_id, int $booking_id, string $party_type, int $party_id, int $net_amount ): bool {
		if ( $net_amount <= 0 ) {
			return false;
		}

		$rate             = CommissionConfig::rate();
		$commission_amount = (int) round( $net_amount * $rate / 100 );
		$receivable_amount = $net_amount - $commission_amount;

		$commission_inserted = $this->insert(
			$order_id,
			$booking_id,
			self::PARTY_PLATFORM,
			null,
			self::TYPE_COMMISSION,
			$commission_amount,
			$rate,
			self::REF_PAYMENT,
			$order_id
		);

		$receivable_inserted = $this->insert(
			$order_id,
			$booking_id,
			$party_type,
			$party_id,
			self::TYPE_RECEIVABLE,
			$receivable_amount,
			$rate,
			self::REF_PAYMENT,
			$order_id
		);

		return $commission_inserted && $receivable_inserted;
	}

	/**
	 * Records the negative reversal pair for a refund against a previously
	 * recorded payment. Reuses the ORIGINAL commission_rate stored on that
	 * order's own `commission` entry — never the platform's current rate —
	 * so a refund always reverses exactly the proportion it originally
	 * recorded, immune to a commission-rate change made in between (task
	 * §17's own "effective_at" concern, satisfied by never re-deriving a
	 * historical rate live). Handles refund-before-settlement and
	 * refund-after-settlement identically: this method only ever adjusts
	 * the RECEIVABLE total for the order, never touches
	 * `wp_bc_settlement_items` — `SettlementService`'s own outstanding
	 * calculation naturally reflects the reduced (possibly negative)
	 * receivable the next time it's read (task §22).
	 */
	public function record_refund( int $order_id, int $refund_id, int $refund_amount ): bool {
		if ( $refund_amount <= 0 ) {
			return false;
		}

		$original_commission = $this->find_one( self::TYPE_COMMISSION, self::REF_PAYMENT, $order_id );
		$original_receivable = $this->find_one( self::TYPE_RECEIVABLE, self::REF_PAYMENT, $order_id );
		if ( ! $original_commission || ! $original_receivable ) {
			// No original payment was ever recorded for this order (e.g. a
			// Shop/B2B order with no booking, or a refund racing ahead of
			// the payment-complete hook) -- nothing to reverse.
			return false;
		}

		$rate               = (int) $original_commission['commission_rate'];
		$commission_reversal = -(int) round( $refund_amount * $rate / 100 );
		$receivable_reversal = -( $refund_amount + $commission_reversal ); // Keep the two exactly summing to -$refund_amount, same split discipline as record_payment().

		$commission_inserted = $this->insert(
			$order_id,
			(int) $original_commission['booking_id'],
			self::PARTY_PLATFORM,
			null,
			self::TYPE_COMMISSION,
			$commission_reversal,
			$rate,
			self::REF_REFUND,
			$refund_id
		);

		$receivable_inserted = $this->insert(
			$order_id,
			(int) $original_receivable['booking_id'],
			$original_receivable['party_type'],
			(int) $original_receivable['party_id'],
			self::TYPE_RECEIVABLE,
			$receivable_reversal,
			$rate,
			self::REF_REFUND,
			$refund_id
		);

		return $commission_inserted && $receivable_inserted;
	}

	private function insert( int $order_id, int $booking_id, string $party_type, ?int $party_id, string $entry_type, int $amount, int $rate, string $reference_type, int $reference_id ): bool {
		global $wpdb;

		/**
		 * `$wpdb->prepare()`'s own `%d`/`%s` placeholders do NOT turn a PHP
		 * `null` into a real SQL `NULL` (they coerce to 0 / '' instead) --
		 * the exact pitfall V2.1 Step 10's own `sent_at` bug already hit and
		 * documented in this codebase. `party_id` is genuinely nullable
		 * (platform commission rows have no party), so it's interpolated as
		 * a literal `NULL` or a separately-prepared `%d` here, never passed
		 * through the placeholder directly.
		 */
		$party_id_sql = null === $party_id ? 'NULL' : $wpdb->prepare( '%d', $party_id );

		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->prefix}bc_ledger_entries
				 (order_id, booking_id, party_type, party_id, entry_type, amount, currency, basis, commission_rate, reference_type, reference_id, created_at)
				 VALUES (%d, %d, %s, {$party_id_sql}, %s, %d, 'IRT', %s, %d, %s, %d, %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
				$order_id,
				$booking_id,
				$party_type,
				$entry_type,
				$amount,
				CommissionConfig::basis(),
				$rate,
				$reference_type,
				$reference_id,
				current_time( 'mysql' )
			)
		);

		return (bool) $inserted;
	}

	/** @return array<string, mixed>|null */
	private function find_one( string $entry_type, string $reference_type, int $reference_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_ledger_entries WHERE entry_type = %s AND reference_type = %s AND reference_id = %d LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$entry_type,
				$reference_type,
				$reference_id
			),
			ARRAY_A
		);
		return $row ?: null;
	}

	/** @return list<array<string, mixed>> */
	public function for_order( int $order_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_ledger_entries WHERE order_id = %d ORDER BY id ASC", $order_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	/** Net (payment + any refund reversal) receivable recorded for one order, for one party. */
	public function order_receivable_net( int $order_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(SUM(amount), 0) FROM {$wpdb->prefix}bc_ledger_entries WHERE order_id = %d AND entry_type = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$order_id,
				self::TYPE_RECEIVABLE
			)
		);
	}

	/** @return list<int> Distinct order ids that have ever had a receivable entry for this party. */
	public function order_ids_for_party( string $party_type, int $party_id ): array {
		global $wpdb;
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT DISTINCT order_id FROM {$wpdb->prefix}bc_ledger_entries WHERE party_type = %s AND party_id = %d AND entry_type = %s ORDER BY order_id DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$party_type,
				$party_id,
				self::TYPE_RECEIVABLE
			)
		);
		return array_map( 'intval', $ids ?: [] );
	}

	/** Net receivable recorded across every order for this party (payments minus any refund reversals), regardless of settlement. */
	public function party_receivable_net( string $party_type, int $party_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(SUM(amount), 0) FROM {$wpdb->prefix}bc_ledger_entries WHERE party_type = %s AND party_id = %d AND entry_type = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$party_type,
				$party_id,
				self::TYPE_RECEIVABLE
			)
		);
	}

	/** @return array{partyType:string, partyId:?int, count:int, commission:int, receivable:int} Platform-wide totals, admin overview only. */
	public function platform_totals(): array {
		global $wpdb;
		$commission = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COALESCE(SUM(amount), 0) FROM {$wpdb->prefix}bc_ledger_entries WHERE entry_type = %s", self::TYPE_COMMISSION ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		$receivable = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COALESCE(SUM(amount), 0) FROM {$wpdb->prefix}bc_ledger_entries WHERE entry_type = %s", self::TYPE_RECEIVABLE ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		$orders = (int) $wpdb->get_var(
			"SELECT COUNT(DISTINCT order_id) FROM {$wpdb->prefix}bc_ledger_entries WHERE reference_type = 'order_payment'" // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		);
		return [ 'commission' => $commission, 'receivable' => $receivable, 'orderCount' => $orders ];
	}

	/** @return list<array{partyType:string, partyId:int, receivable:int}> Every party with at least one receivable entry, most-recent-activity first. */
	public function parties_with_receivables(): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT party_type, party_id, SUM(amount) AS net, MAX(id) AS last_id
				 FROM {$wpdb->prefix}bc_ledger_entries
				 WHERE entry_type = %s
				 GROUP BY party_type, party_id
				 ORDER BY last_id DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::TYPE_RECEIVABLE
			),
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ) => [ 'partyType' => $r['party_type'], 'partyId' => (int) $r['party_id'], 'receivable' => (int) $r['net'] ],
			$rows ?: []
		);
	}

	/** @param array<string, mixed> $row @return array<string, mixed> */
	private function format( array $row ): array {
		return [
			'id'             => (int) $row['id'],
			'orderId'        => (int) $row['order_id'],
			'bookingId'      => (int) $row['booking_id'],
			'partyType'      => $row['party_type'],
			'partyId'        => null !== $row['party_id'] ? (int) $row['party_id'] : null,
			'entryType'      => $row['entry_type'],
			'amount'         => (int) $row['amount'],
			'currency'       => $row['currency'],
			'basis'          => $row['basis'],
			'commissionRate' => (int) $row['commission_rate'],
			'referenceType'  => $row['reference_type'],
			'referenceId'    => (int) $row['reference_id'],
			'createdAt'      => $row['created_at'],
		];
	}
}
