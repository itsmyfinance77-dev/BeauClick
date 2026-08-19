<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns;

/**
 * Sole owner of `wp_bc_campaigns`/`wp_bc_campaign_usages` — every read/write
 * to either table goes through this class, matching the one-service-per-
 * table-group convention already established by TierService/MembershipService
 * (beauclick-loyalty) and ReferralService (beauclick-referral). This class
 * intentionally has no eligibility/discount-calculation logic of its own —
 * that lives in EligibilityResolver, which is pure business logic operating
 * on the data this class provides, so each class stays independently
 * testable (data access vs. decision logic).
 */
final class CampaignService {

	public const STATUS_DRAFT    = 'draft';
	public const STATUS_ACTIVE   = 'active';
	public const STATUS_PAUSED   = 'paused';
	public const STATUS_ARCHIVED = 'archived';

	public const TYPE_PERCENTAGE = 'percentage';
	public const TYPE_FIXED      = 'fixed';

	public const SCOPE_ALL           = 'all';
	public const SCOPE_FIRST_BOOKING = 'first_booking';
	public const SCOPE_RETURNING     = 'returning';

	// ------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------

	/** @return list<array<string, mixed>> Newest first. */
	public function all(): array {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_campaigns ORDER BY id DESC", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		return array_map( [ $this, 'format' ], $rows ?: [] );
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_campaigns WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ? $this->format( $row ) : null;
	}

	/**
	 * Active campaigns whose date window includes $at and whose
	 * service/provider targeting could possibly match the given context —
	 * the exact usage-limit/customer-scope checks live in
	 * EligibilityResolver (they need CampaignService's own usage-query
	 * methods below, not just this table). Bounded by the `status_dates`
	 * index; filtered in PHP rather than a larger dynamic SQL WHERE clause,
	 * matching TierService::for_points()'s own "small bounded table, filter
	 * in PHP" style — realistic active-campaign counts are small, and this
	 * keeps the targeting logic readable and independently testable.
	 *
	 * @return list<array<string, mixed>>
	 */
	public function active_candidates( ?int $service_id, ?int $provider_id, string $at ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_campaigns
				 WHERE status = %s
				 AND (starts_at IS NULL OR starts_at <= %s)
				 AND (ends_at IS NULL OR ends_at >= %s)
				 ORDER BY id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::STATUS_ACTIVE,
				$at,
				$at
			),
			ARRAY_A
		);

		$candidates = array_map( [ $this, 'format' ], $rows ?: [] );

		return array_values(
			array_filter(
				$candidates,
				static function ( array $c ) use ( $service_id, $provider_id ): bool {
					$service_matches  = null === $c['serviceId'] || $c['serviceId'] === $service_id;
					$provider_matches = null === $c['providerId'] || $c['providerId'] === $provider_id;
					return $service_matches && $provider_matches;
				}
			)
		);
	}

	/** Count of currently-live (`applied`, not `released`) usages, optionally scoped to one customer. */
	public function usage_count( int $campaign_id, ?int $customer_id = null ): int {
		global $wpdb;
		if ( null !== $customer_id ) {
			return (int) $wpdb->get_var(
				$wpdb->prepare(
					"SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND customer_id = %d AND status = 'applied'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					$campaign_id,
					$customer_id
				)
			);
		}
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND status = 'applied'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$campaign_id
			)
		);
	}

	/** @return array{count:int, totalDiscount:int} Admin reporting section — live, not cached (small table, per-campaign query). */
	public function usage_summary( int $campaign_id ): array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT COUNT(*) AS cnt, COALESCE(SUM(discount_amount), 0) AS total
				 FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND status = 'applied'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$campaign_id
			),
			ARRAY_A
		);
		return [
			'count'         => (int) ( $row['cnt'] ?? 0 ),
			'totalDiscount' => (int) ( $row['total'] ?? 0 ),
		];
	}

	// ------------------------------------------------------------------
	// Writes — lifecycle
	// ------------------------------------------------------------------

	/**
	 * @param array<string, mixed> $fields
	 * @return array{id:int}|string New campaign id on success, a Persian error message on failure.
	 */
	public function create( array $fields ) {
		$error = $this->validate( $fields, null );
		if ( null !== $error ) {
			return $error;
		}

		global $wpdb;
		$now = current_time( 'mysql' );

		$wpdb->insert(
			$wpdb->prefix . 'bc_campaigns',
			[
				'name'                     => sanitize_text_field( (string) $fields['name'] ),
				'discount_type'            => (string) $fields['discountType'],
				'discount_value'           => (int) $fields['discountValue'],
				'max_discount_amount'      => isset( $fields['maxDiscountAmount'] ) && '' !== $fields['maxDiscountAmount'] ? (int) $fields['maxDiscountAmount'] : null,
				'status'                   => self::STATUS_DRAFT,
				'starts_at'                => ! empty( $fields['startsAt'] ) ? (string) $fields['startsAt'] : null,
				'ends_at'                  => ! empty( $fields['endsAt'] ) ? (string) $fields['endsAt'] : null,
				'service_id'               => ! empty( $fields['serviceId'] ) ? (int) $fields['serviceId'] : null,
				'provider_id'              => ! empty( $fields['providerId'] ) ? (int) $fields['providerId'] : null,
				'customer_scope'           => (string) ( $fields['customerScope'] ?? self::SCOPE_ALL ),
				'min_order_value'          => isset( $fields['minOrderValue'] ) && '' !== $fields['minOrderValue'] ? (int) $fields['minOrderValue'] : null,
				'usage_limit_total'        => isset( $fields['usageLimitTotal'] ) && '' !== $fields['usageLimitTotal'] ? (int) $fields['usageLimitTotal'] : null,
				'usage_limit_per_customer' => isset( $fields['usageLimitPerCustomer'] ) && '' !== $fields['usageLimitPerCustomer'] ? (int) $fields['usageLimitPerCustomer'] : null,
				'created_by'               => isset( $fields['createdBy'] ) ? (int) $fields['createdBy'] : null,
				'created_at'               => $now,
				'updated_at'               => $now,
			],
			[ '%s', '%s', '%d', '%d', '%s', '%s', '%s', '%d', '%d', '%s', '%d', '%d', '%d', '%d', '%s', '%s' ]
		);

		return [ 'id' => (int) $wpdb->insert_id ];
	}

	/**
	 * @param array<string, mixed> $fields
	 * @return array<string, mixed>|string Updated campaign on success, a Persian error message on failure.
	 */
	public function update( int $id, array $fields ) {
		$existing = $this->find( $id );
		if ( ! $existing ) {
			return 'کمپین پیدا نشد.';
		}
		if ( self::STATUS_ARCHIVED === $existing['status'] ) {
			return 'کمپین بایگانی‌شده قابل ویرایش نیست.';
		}

		$error = $this->validate( $fields, $existing );
		if ( null !== $error ) {
			return $error;
		}

		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_campaigns',
			[
				'name'                     => sanitize_text_field( (string) $fields['name'] ),
				'discount_type'            => (string) $fields['discountType'],
				'discount_value'           => (int) $fields['discountValue'],
				'max_discount_amount'      => isset( $fields['maxDiscountAmount'] ) && '' !== $fields['maxDiscountAmount'] ? (int) $fields['maxDiscountAmount'] : null,
				'starts_at'                => ! empty( $fields['startsAt'] ) ? (string) $fields['startsAt'] : null,
				'ends_at'                  => ! empty( $fields['endsAt'] ) ? (string) $fields['endsAt'] : null,
				'service_id'               => ! empty( $fields['serviceId'] ) ? (int) $fields['serviceId'] : null,
				'provider_id'              => ! empty( $fields['providerId'] ) ? (int) $fields['providerId'] : null,
				'customer_scope'           => (string) ( $fields['customerScope'] ?? self::SCOPE_ALL ),
				'min_order_value'          => isset( $fields['minOrderValue'] ) && '' !== $fields['minOrderValue'] ? (int) $fields['minOrderValue'] : null,
				'usage_limit_total'        => isset( $fields['usageLimitTotal'] ) && '' !== $fields['usageLimitTotal'] ? (int) $fields['usageLimitTotal'] : null,
				'usage_limit_per_customer' => isset( $fields['usageLimitPerCustomer'] ) && '' !== $fields['usageLimitPerCustomer'] ? (int) $fields['usageLimitPerCustomer'] : null,
				'updated_at'               => current_time( 'mysql' ),
			],
			[ 'id' => $id ],
			[ '%s', '%s', '%d', '%d', '%s', '%s', '%d', '%d', '%s', '%d', '%d', '%d', '%s' ],
			[ '%d' ]
		);

		return $this->find( $id ) ?? 'کمپین پیدا نشد.';
	}

	/** @return true|string */
	public function activate( int $id ) {
		return $this->transition( $id, self::STATUS_ACTIVE, [ self::STATUS_DRAFT, self::STATUS_PAUSED ] );
	}

	/** @return true|string */
	public function pause( int $id ) {
		return $this->transition( $id, self::STATUS_PAUSED, [ self::STATUS_ACTIVE ] );
	}

	/** Terminal — an archived campaign can never be reactivated (create a new one instead). @return true|string */
	public function archive( int $id ) {
		return $this->transition( $id, self::STATUS_ARCHIVED, [ self::STATUS_DRAFT, self::STATUS_ACTIVE, self::STATUS_PAUSED ] );
	}

	/** @param string[] $allowed_from @return true|string */
	private function transition( int $id, string $to, array $allowed_from ) {
		$campaign = $this->find( $id );
		if ( ! $campaign ) {
			return 'کمپین پیدا نشد.';
		}
		if ( ! in_array( $campaign['status'], $allowed_from, true ) ) {
			return 'این تغییر وضعیت برای کمپین در وضعیت فعلی مجاز نیست.';
		}

		global $wpdb;
		$wpdb->update(
			$wpdb->prefix . 'bc_campaigns',
			[ 'status' => $to, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $id ],
			[ '%s', '%s' ],
			[ '%d' ]
		);

		return true;
	}

	// ------------------------------------------------------------------
	// Writes — usage bookkeeping (called only from Pricing\CampaignDiscount / Pricing\UsageReleaseListener)
	// ------------------------------------------------------------------

	/**
	 * INSERT-first, not SELECT-then-INSERT — the `UNIQUE KEY booking_id`
	 * constraint is the real, race-safe idempotency guard (mirrors
	 * `wp_bc_referrals`' own `INSERT IGNORE` discipline). Returns false if a
	 * usage row for this booking already exists, telling the caller not to
	 * add a second fee.
	 */
	public function record_usage( int $campaign_id, int $booking_id, int $order_id, int $customer_id, int $discount_amount ): bool {
		global $wpdb;
		$now = current_time( 'mysql' );

		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->prefix}bc_campaign_usages
				 (campaign_id, booking_id, order_id, customer_id, discount_amount, status, created_at, updated_at)
				 VALUES (%d, %d, %d, %d, %d, 'applied', %s, %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$campaign_id,
				$booking_id,
				$order_id,
				$customer_id,
				$discount_amount,
				$now,
				$now
			)
		);

		return (bool) $inserted;
	}

	/**
	 * V2.4 Step 26 (part 2), GAP-04. `record_usage()`'s own `UNIQUE(booking_id)`
	 * only ever guarded against the SAME booking being recorded twice — it
	 * never protected the CAP itself. `EligibilityResolver::is_eligible()`'s
	 * `usage_count() >= limit` check runs well before this method (candidate
	 * SELECTion, not the authoritative gate), so two concurrent bookings for
	 * DIFFERENT booking_ids against the same near-full campaign could both
	 * read a count still under the limit and both then insert successfully,
	 * overshooting `usageLimitTotal`/`usageLimitPerCustomer`.
	 *
	 * This is the real, authoritative, race-safe gate — one atomic
	 * `INSERT ... SELECT ... WHERE` statement, the cap re-check and the
	 * insert as a single unit of work, the same "one statement is the real
	 * guard" idiom `record_usage()`'s own `INSERT IGNORE` already uses (see
	 * that method's docblock), never a multi-statement check-then-insert. An
	 * earlier version of this method used an explicit `START TRANSACTION` +
	 * `SELECT ... FOR UPDATE`; abandoned after it was found to corrupt
	 * `WP_UnitTestCase`'s own per-test transaction-rollback isolation for
	 * every test that exercises `CampaignDiscount::apply()` (a `START
	 * TRANSACTION` always silently commits whatever transaction the test
	 * framework already had open) — a real, reproduced problem (20+
	 * cascading failures across unrelated test files), not a hypothetical
	 * one. This single-statement form needs no explicit transaction of its
	 * own, so it composes safely inside any caller's transaction (or none),
	 * exactly like every other write in this codebase. Empirically verified
	 * under genuine concurrent load (`CampaignUsageCapTest`'s own
	 * concurrency test, and ad hoc multi-process racing during development):
	 * N truly concurrent connections against a cap of K always leave exactly
	 * K rows, never more — MySQL either blocks the losing connections until
	 * the winner's INSERT is visible to their own re-evaluated subquery, or
	 * resolves the conflict via its own deadlock detector, which aborts the
	 * loser's statement outright (surfaced here as a normal `false` return,
	 * indistinguishable from "cap already reached" -- correct, since both
	 * mean "no discount granted this attempt").
	 */
	public function record_usage_within_cap( int $campaign_id, int $booking_id, int $order_id, int $customer_id, int $discount_amount, ?int $usage_limit_total, ?int $usage_limit_per_customer ): bool {
		global $wpdb;
		$now = current_time( 'mysql' );

		$conditions = [];
		$params     = [ $campaign_id, $booking_id, $order_id, $customer_id, $discount_amount, $now, $now ];

		if ( null !== $usage_limit_total ) {
			$conditions[] = "(SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND status = 'applied') < %d";
			$params[]     = $campaign_id;
			$params[]     = $usage_limit_total;
		}

		if ( null !== $usage_limit_per_customer ) {
			$conditions[] = "(SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND customer_id = %d AND status = 'applied') < %d";
			$params[]     = $campaign_id;
			$params[]     = $customer_id;
			$params[]     = $usage_limit_per_customer;
		}

		$where = $conditions ? ( 'WHERE ' . implode( ' AND ', $conditions ) ) : '';

		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->prefix}bc_campaign_usages
				 (campaign_id, booking_id, order_id, customer_id, discount_amount, status, created_at, updated_at)
				 SELECT %d, %d, %d, %d, %d, 'applied', %s, %s
				 FROM DUAL
				 {$where}", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
				$params
			)
		);

		return (bool) $inserted;
	}

	/** Called when the order a campaign discount was applied to dies (cancelled/failed/refunded) — frees the usage slot without deleting the audit row. */
	public function release_usage_for_order( int $order_id ): void {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_campaign_usages SET status = 'released', updated_at = %s WHERE order_id = %d AND status = 'applied'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				current_time( 'mysql' ),
				$order_id
			)
		);
	}

	// ------------------------------------------------------------------

	/** @param array<string, mixed> $fields @param array<string, mixed>|null $existing */
	private function validate( array $fields, ?array $existing ): ?string {
		if ( '' === trim( (string) ( $fields['name'] ?? '' ) ) ) {
			return 'نام کمپین الزامی است.';
		}

		$type = (string) ( $fields['discountType'] ?? '' );
		if ( ! in_array( $type, [ self::TYPE_PERCENTAGE, self::TYPE_FIXED ], true ) ) {
			return 'نوع تخفیف نامعتبر است.';
		}

		$value = (int) ( $fields['discountValue'] ?? 0 );
		if ( self::TYPE_PERCENTAGE === $type && ( $value < 1 || $value > 100 ) ) {
			return 'درصد تخفیف باید بین ۱ تا ۱۰۰ باشد.';
		}
		if ( self::TYPE_FIXED === $type && $value < 1 ) {
			return 'مبلغ تخفیف باید بزرگ‌تر از صفر باشد.';
		}

		if ( isset( $fields['maxDiscountAmount'] ) && '' !== $fields['maxDiscountAmount'] && (int) $fields['maxDiscountAmount'] < 1 ) {
			return 'حداکثر مبلغ تخفیف باید بزرگ‌تر از صفر باشد.';
		}

		if ( ! empty( $fields['startsAt'] ) && ! empty( $fields['endsAt'] ) && strtotime( (string) $fields['endsAt'] ) <= strtotime( (string) $fields['startsAt'] ) ) {
			return 'تاریخ پایان باید بعد از تاریخ شروع باشد.';
		}

		$scope = (string) ( $fields['customerScope'] ?? self::SCOPE_ALL );
		if ( ! in_array( $scope, [ self::SCOPE_ALL, self::SCOPE_FIRST_BOOKING, self::SCOPE_RETURNING ], true ) ) {
			return 'محدوده مشتری نامعتبر است.';
		}

		foreach ( [ 'minOrderValue', 'usageLimitTotal', 'usageLimitPerCustomer' ] as $field ) {
			if ( isset( $fields[ $field ] ) && '' !== $fields[ $field ] && (int) $fields[ $field ] < ( 'minOrderValue' === $field ? 0 : 1 ) ) {
				return 'مقادیر حد و آستانه نمی‌توانند منفی یا صفر (به‌جز حداقل مبلغ سفارش) باشند.';
			}
		}

		return null;
	}

	/** @param array<string, mixed> $row @return array<string, mixed> */
	private function format( array $row ): array {
		return [
			'id'                     => (int) $row['id'],
			'name'                   => $row['name'],
			'discountType'           => $row['discount_type'],
			'discountValue'          => (int) $row['discount_value'],
			'maxDiscountAmount'      => null !== $row['max_discount_amount'] ? (int) $row['max_discount_amount'] : null,
			'status'                 => $row['status'],
			'startsAt'               => $row['starts_at'],
			'endsAt'                 => $row['ends_at'],
			'serviceId'              => null !== $row['service_id'] ? (int) $row['service_id'] : null,
			'providerId'             => null !== $row['provider_id'] ? (int) $row['provider_id'] : null,
			'customerScope'          => $row['customer_scope'],
			'minOrderValue'          => null !== $row['min_order_value'] ? (int) $row['min_order_value'] : null,
			'usageLimitTotal'        => null !== $row['usage_limit_total'] ? (int) $row['usage_limit_total'] : null,
			'usageLimitPerCustomer'  => null !== $row['usage_limit_per_customer'] ? (int) $row['usage_limit_per_customer'] : null,
			'createdBy'              => null !== $row['created_by'] ? (int) $row['created_by'] : null,
		];
	}
}
