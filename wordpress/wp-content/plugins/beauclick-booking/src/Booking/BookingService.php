<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Booking;

use BeauClick\Booking\Notifications\BookingMailer;

/**
 * The one place booking business logic lives — REST controller and
 * beauclick-payments' order-status/payment-complete hooks both go through
 * this, not raw $wpdb calls, so the concurrency-safety guarantees below
 * aren't something a caller can accidentally bypass.
 */
final class BookingService {

	public const STATUS_PENDING   = 'pending';
	public const STATUS_CONFIRMED = 'confirmed';
	public const STATUS_COMPLETED = 'completed';
	public const STATUS_CANCELLED = 'cancelled';
	public const STATUS_NO_SHOW   = 'no_show';

	/**
	 * A booking created before payment holds its slot for this long, not
	 * forever — an abandoned checkout must not permanently lock a time
	 * slot other customers could book. 15 minutes is generous enough for a
	 * redirect-based gateway round trip (the norm for Iranian gateways —
	 * ZarinPal et al.) without meaningfully starving availability.
	 */
	public const HOLD_MINUTES = 15;

	/**
	 * A production-readiness audit flagged that booking creation had no
	 * abuse guard: since every self-registered customer account gets
	 * bc_book_service automatically, a scripted account could repeatedly
	 * hold slots (each hold locks one for HOLD_MINUTES, re-claiming it the
	 * instant it's about to expire) and starve real customers out of a
	 * popular provider's availability — a pure request-rate limit alone
	 * wouldn't stop this, since the attack is about *accumulating*
	 * concurrent holds, not the request rate. Capping how many holds one
	 * customer can have open at once addresses the actual threat directly.
	 */
	public const MAX_CONCURRENT_HOLDS_PER_CUSTOMER = 5;

	/**
	 * Atomically claims a slot (open, OR held by an expired hold nobody
	 * confirmed) and creates the booking in one operation. Concurrency
	 * safety comes from a single `UPDATE ... WHERE (...)` — MySQL row-locks
	 * that statement, so under real concurrent requests only one caller can
	 * flip the row and see affected_rows = 1; every other concurrent caller
	 * sees 0 and gets a conflict. This is why booking creation is NOT "read
	 * slot, check it's open, then insert" as two separate steps — that
	 * pattern has a race window this one doesn't.
	 *
	 * Accepting an *expired* held slot here (not just an 'open' one) is
	 * what keeps the system correct in real time even before the periodic
	 * sweep (Cron\HoldExpiryScheduler) gets around to formally releasing
	 * it and cancelling the abandoned booking record — a customer is never
	 * blocked by cron timing, only by an *active* hold.
	 *
	 * @return array{booking_id:int}|null|false Null means the slot was not
	 * available; false means the customer already has too many concurrent
	 * pending holds (see MAX_CONCURRENT_HOLDS_PER_CUSTOMER) — distinct
	 * outcomes the REST controller maps to 409 vs 429 respectively, same
	 * three-way-return shape as ConversationService::send_message() and
	 * AssistantService::send().
	 */
	public function create_booking( int $customer_id, int $provider_id, int $slot_id, ?int $service_id = null ): array|null|false {
		global $wpdb;

		$active_holds = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status = %s", $customer_id, self::STATUS_PENDING ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $active_holds >= self::MAX_CONCURRENT_HOLDS_PER_CUSTOMER ) {
			return false;
		}

		$slots_table = $wpdb->prefix . 'bc_availability_slots';
		$now         = current_time( 'mysql' );
		$held_until  = gmdate( 'Y-m-d H:i:s', strtotime( $now ) + self::HOLD_MINUTES * MINUTE_IN_SECONDS );

		$claimed = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$slots_table}
				 SET status = 'held', held_until = %s
				 WHERE id = %d AND provider_id = %d
				   AND ( status = 'open' OR ( status = 'held' AND held_until < %s ) )", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$held_until,
				$slot_id,
				$provider_id,
				$now
			)
		);

		if ( ! $claimed ) {
			return null; // Lost the race, slot is actively held by someone else, or the slot/provider pair is invalid.
		}

		$slot = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$slots_table} WHERE id = %d", $slot_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$bookings_table = $wpdb->prefix . 'bc_bookings';

		$wpdb->insert(
			$bookings_table,
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'service_id'  => $service_id,
				'slot_id'     => $slot_id,
				'slot_start'  => $slot['start_at'],
				'slot_end'    => $slot['end_at'],
				'status'      => self::STATUS_PENDING,
				'expires_at'  => $held_until,
				'created_at'  => $now,
				'updated_at'  => $now,
			]
		);

		$booking_id = $wpdb->insert_id;

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'booking_created', 'booking', $booking_id, $customer_id, [ 'provider_id' => $provider_id ] );
		}

		return [ 'booking_id' => $booking_id ];
	}

	/**
	 * Cancelling releases the slot back to 'open' — but only if the
	 * cancel itself atomically succeeded (a completed/already-cancelled
	 * booking is left alone), same compare-and-swap discipline as claiming.
	 */
	public function cancel_booking( int $booking_id, string $reason = '' ): bool {
		global $wpdb;

		$booking = $this->find( $booking_id );
		if ( ! $booking ) {
			return false;
		}

		$cancelled = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_bookings
				 SET status = %s, cancelled_reason = %s, updated_at = %s
				 WHERE id = %d AND status NOT IN (%s, %s)",
				self::STATUS_CANCELLED,
				$reason,
				current_time( 'mysql' ),
				$booking_id,
				self::STATUS_COMPLETED,
				self::STATUS_CANCELLED
			)
		);

		if ( ! $cancelled ) {
			return false;
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'status' => 'open', 'held_until' => null ],
			[ 'id' => $booking['slot_id'] ]
		);

		$actor_id = get_current_user_id();
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'booking_cancelled', 'booking', $booking_id, $actor_id ?: null, [ 'reason' => $reason ] );
		}
		( new BookingMailer() )->send_cancelled( $booking, $actor_id );

		// V2.1 Step 10 -- the authoritative "a slot just became newly
		// available" moment (this method already only reaches here on a
		// real, atomic pending/confirmed -> cancelled transition that
		// genuinely freed the slot). beauclick-booking deliberately doesn't
		// know Waitlist exists — same one-way hook-based dependency
		// direction as every other cross-plugin seam in this codebase (see
		// beauclick/booking/completed).
		do_action( 'beauclick/booking/slot_opened', (int) $booking['slot_id'], (int) $booking['provider_id'], $booking['service_id'] ? (int) $booking['service_id'] : null, substr( (string) $booking['slot_start'], 0, 10 ) );

		/**
		 * V2.3 Step 18 (FIN-02) -- this REST-driven cancel() is the real,
		 * primary customer/professional-facing cancellation path (unlike
		 * the WooCommerce-order-status-driven on_order_dead() path, which
		 * only ever reacts, never initiates), and until this step it never
		 * triggered a refund for an already-paid booking at all — a real
		 * financial-correctness gap the V2.3 discovery audit found and
		 * named (PRODUCT_GAP_REGISTER.md's FIN-02). $booking here is the
		 * pre-cancellation row already fetched above, so it still carries
		 * the real wc_order_id — beauclick-booking deliberately still
		 * doesn't know beauclick-payments/WooCommerce exists (same one-way
		 * dependency direction as every hook in this file); the actual
		 * refund decision and wc_create_refund() call live entirely in
		 * beauclick-payments\Plugin::on_booking_cancelled().
		 */
		do_action( 'beauclick/booking/cancelled', $booking_id, $booking, $actor_id ?: null );

		return true;
	}

	/**
	 * Confirming only succeeds while the booking is still 'pending' — if a
	 * hold already expired and the sweep cancelled it (or it was cancelled
	 * some other way) before a late payment confirmation arrives, this
	 * correctly refuses rather than confirming a booking whose slot may
	 * already belong to someone else. beauclick-payments treats that
	 * refusal as "payment succeeded but booking could not be honored" and
	 * triggers a refund — see Plugin::confirm_or_refund().
	 */
	public function confirm_booking( int $booking_id ): bool {
		$booking = $this->find( $booking_id );
		if ( ! $this->transition( $booking_id, self::STATUS_CONFIRMED, [ self::STATUS_PENDING ], 'booking_confirmed' ) ) {
			return false;
		}

		if ( $booking ) {
			global $wpdb;
			$wpdb->update(
				$wpdb->prefix . 'bc_availability_slots',
				[ 'status' => 'booked', 'held_until' => null ],
				[ 'id' => $booking['slot_id'] ]
			);

			// One of the ranking signals the business plan names explicitly
			// (architecture doc §8's wp_bc_events comment) — how fast a
			// provider confirms a pending booking. Logged against the
			// provider so the future scoring algorithm can read it directly.
			if ( function_exists( 'beauclick_core' ) ) {
				$elapsed = max( 0, strtotime( current_time( 'mysql' ) ) - strtotime( $booking['created_at'] ) );
				beauclick_core()->events()->log( 'response_time_seconds', 'provider', (int) $booking['provider_id'], null, [ 'seconds' => $elapsed, 'booking_id' => $booking_id ] );
			}

			( new BookingMailer() )->send_confirmed( $booking );
		}

		return true;
	}

	/**
	 * V2.1 Step 10 (BOOK-04) -- a small, properly scoped professional
	 * action, not an attendance system. Only ever transitions a booking
	 * whose slot has actually already passed (never lets a provider mark a
	 * future booking as a no-show pre-emptively) and only from `confirmed`
	 * -- a booking already completed/cancelled/no-show is left alone, same
	 * compare-and-swap discipline as every other transition here.
	 * Deliberately does not notify the customer (a no-show mark is
	 * internal professional bookkeeping, not something to actively push to
	 * the person who didn't show up).
	 */
	public function mark_no_show( int $booking_id ): bool {
		$booking = $this->find( $booking_id );
		if ( ! $booking ) {
			return false;
		}
		if ( strtotime( (string) $booking['slot_end'] ) > strtotime( current_time( 'mysql' ) ) ) {
			return false; // Slot hasn't even ended yet -- too early to call this a no-show.
		}
		return $this->transition( $booking_id, self::STATUS_NO_SHOW, [ self::STATUS_CONFIRMED ], 'booking_no_show' );
	}

	public function complete_booking( int $booking_id ): bool {
		$completed = $this->transition( $booking_id, self::STATUS_COMPLETED, [ self::STATUS_CONFIRMED ], 'booking_completed' );

		if ( $completed ) {
			// V2.0 Step 1's loyalty-earning hook seam (see beauclick-loyalty\
			// EarningRules) — booking-plugin code deliberately doesn't know
			// loyalty exists, same one-way dependency direction as every
			// other cross-plugin hook in this codebase. transition() only
			// returns true on the single real confirmed->completed flip, so
			// this fires at most once per booking.
			do_action( 'beauclick/booking/completed', $booking_id );
		}

		return $completed;
	}

	/**
	 * The periodic backstop (Cron\HoldExpiryScheduler): cancels pending
	 * bookings whose hold has expired and releases their slots. Each
	 * booking's cancel is atomically gated on status still being 'pending'
	 * (a payment that confirmed it in the meantime wins, this is skipped),
	 * and each slot's release is atomically gated on it still being the
	 * SAME expired hold (re-checking held_until, not just "is held") — a
	 * slot re-claimed by a different customer in real time via
	 * create_booking()'s own expired-hold handling is never touched here.
	 *
	 * @return int Number of bookings expired.
	 */
	public function expire_stale_holds(): int {
		global $wpdb;
		$now = current_time( 'mysql' );

		$stale = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, slot_id, provider_id, service_id, slot_start FROM {$wpdb->prefix}bc_bookings
				 WHERE status = %s AND expires_at IS NOT NULL AND expires_at < %s
				 LIMIT 100", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::STATUS_PENDING,
				$now
			),
			ARRAY_A
		);

		$expired_count = 0;

		foreach ( $stale as $row ) {
			$cancelled = $wpdb->query(
				$wpdb->prepare(
					"UPDATE {$wpdb->prefix}bc_bookings SET status = %s, cancelled_reason = 'expired', updated_at = %s WHERE id = %d AND status = %s",
					self::STATUS_CANCELLED,
					$now,
					$row['id'],
					self::STATUS_PENDING
				)
			);

			if ( ! $cancelled ) {
				continue; // Something else (a payment confirmation) won the race for this one.
			}

			$wpdb->query(
				$wpdb->prepare(
					"UPDATE {$wpdb->prefix}bc_availability_slots SET status = 'open', held_until = NULL WHERE id = %d AND status = 'held' AND held_until < %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					$row['slot_id'],
					$now
				)
			);

			if ( function_exists( 'beauclick_core' ) ) {
				beauclick_core()->events()->log( 'booking_expired', 'booking', (int) $row['id'] );
			}

			// Same authoritative "slot newly available" moment as
			// cancel_booking() above — an abandoned, expired hold releasing
			// the slot is exactly as real an availability event as an
			// explicit cancellation.
			do_action( 'beauclick/booking/slot_opened', (int) $row['slot_id'], (int) $row['provider_id'], $row['service_id'] ? (int) $row['service_id'] : null, substr( (string) $row['slot_start'], 0, 10 ) );

			++$expired_count;
		}

		return $expired_count;
	}

	private function transition( int $booking_id, string $to, array $allowed_from, string $event ): bool {
		global $wpdb;

		$placeholders = implode( ',', array_fill( 0, count( $allowed_from ), '%s' ) );
		$affected     = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$wpdb->prefix}bc_bookings SET status = %s, updated_at = %s WHERE id = %d AND status IN ({$placeholders})", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( [ $to, current_time( 'mysql' ), $booking_id ], $allowed_from )
			)
		);

		if ( ! $affected ) {
			return false;
		}

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( $event, 'booking', $booking_id );
		}

		return true;
	}

	public function find( int $booking_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	/**
	 * V2.2 Step 14 — every booking this customer has ever made, for their
	 * own data export. Bookings themselves carry no directly-identifying
	 * data beyond the customer's own id (times/status/provider/service),
	 * so this is a plain read — nothing here needs redaction for the
	 * customer's own copy of their own history.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function export_for_customer( int $customer_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT id, provider_id, service_id, slot_start, slot_end, status, cancelled_reason, created_at FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d ORDER BY slot_start DESC", $customer_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return $rows ?: [];
	}

	/**
	 * V2.2 Step 14 (§9) — account deletion must not leave a broken booking
	 * lifecycle. A customer with any booking still pending or confirmed
	 * (i.e. not yet cancelled/completed/no-show) has a real, unresolved
	 * commitment — deletion is blocked until it resolves itself naturally
	 * (completes, or the customer/provider cancels it through the existing
	 * cancellation flow), never force-cancelled as a side effect of a
	 * privacy request.
	 */
	public function has_pending_or_confirmed_booking( int $customer_id ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status IN ('pending','confirmed') LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$customer_id
			)
		);
	}
}
