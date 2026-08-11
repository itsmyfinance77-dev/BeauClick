<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Booking;

/**
 * The one place booking business logic lives — REST controller and any
 * future callers (e.g. beauclick-payments' order-status webhook in Phase 6)
 * both go through this, not raw $wpdb calls, so the concurrency-safety
 * guarantee below isn't something callers can accidentally bypass.
 */
final class BookingService {

	public const STATUS_PENDING   = 'pending';
	public const STATUS_CONFIRMED = 'confirmed';
	public const STATUS_COMPLETED = 'completed';
	public const STATUS_CANCELLED = 'cancelled';
	public const STATUS_NO_SHOW   = 'no_show';

	/**
	 * Thrown when a slot can't be claimed — either it never existed, or (the
	 * case that actually matters) someone else claimed it first.
	 */
	public function __construct() {}

	/**
	 * Atomically claims an open slot and creates the booking in one
	 * operation. Concurrency safety comes from a single `UPDATE ... WHERE
	 * status = 'open'` — MySQL row-locks that statement, so under real
	 * concurrent requests only one can flip status from 'open' to 'booked'
	 * and see affected_rows = 1; every other concurrent caller sees 0 and
	 * gets a conflict, never a double-booked slot. This is why booking
	 * creation is NOT "read slot, check it's open, then insert" as two
	 * separate steps — that pattern has a race window this one doesn't.
	 *
	 * @return array{booking_id:int}|null Null means the slot was not available (already booked, or doesn't exist).
	 */
	public function create_booking( int $customer_id, int $provider_id, int $slot_id, ?int $service_id = null ): ?array {
		global $wpdb;

		$slots_table = $wpdb->prefix . 'bc_availability_slots';

		$claimed = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$slots_table} SET status = 'booked' WHERE id = %d AND provider_id = %d AND status = 'open'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$slot_id,
				$provider_id
			)
		);

		if ( ! $claimed ) {
			return null; // Lost the race (or the slot/provider pair was never valid) — no booking created.
		}

		$slot = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$slots_table} WHERE id = %d", $slot_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$bookings_table = $wpdb->prefix . 'bc_bookings';
		$now            = current_time( 'mysql' );

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
	 * Cancelling releases the slot back to 'open' (unless the booking was
	 * already completed, in which case there's no slot left to release —
	 * completed bookings aren't cancellable through this path at all, the
	 * caller should reject that before calling here).
	 */
	public function cancel_booking( int $booking_id, string $reason = '' ): bool {
		global $wpdb;

		$booking = $this->find( $booking_id );
		if ( ! $booking || in_array( $booking['status'], [ self::STATUS_COMPLETED, self::STATUS_CANCELLED ], true ) ) {
			return false;
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_bookings',
			[ 'status' => self::STATUS_CANCELLED, 'cancelled_reason' => $reason, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $booking_id ]
		);

		$wpdb->update(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'status' => 'open' ],
			[ 'id' => $booking['slot_id'] ]
		);

		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'booking_cancelled', 'booking', $booking_id, get_current_user_id() ?: null, [ 'reason' => $reason ] );
		}

		return true;
	}

	public function confirm_booking( int $booking_id ): bool {
		return $this->transition( $booking_id, self::STATUS_CONFIRMED, [ self::STATUS_PENDING ], 'booking_confirmed' );
	}

	public function complete_booking( int $booking_id ): bool {
		return $this->transition( $booking_id, self::STATUS_COMPLETED, [ self::STATUS_CONFIRMED ], 'booking_completed' );
	}

	private function transition( int $booking_id, string $to, array $allowed_from, string $event ): bool {
		global $wpdb;
		$booking = $this->find( $booking_id );
		if ( ! $booking || ! in_array( $booking['status'], $allowed_from, true ) ) {
			return false;
		}

		$wpdb->update(
			$wpdb->prefix . 'bc_bookings',
			[ 'status' => $to, 'updated_at' => current_time( 'mysql' ) ],
			[ 'id' => $booking_id ]
		);

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
}
