<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Booking;

use BeauClick\Booking\Notifications\BookingMailer;
use BeauClick\Marketplace\Support\ProviderLookup;

/**
 * V2.2 Step 15 — rescheduling is structurally a cancel-and-atomic-reclaim
 * on the SAME booking row, not a new concurrency primitive: reserve the new
 * slot with the exact claim query BookingService::create_booking() already
 * uses, move the booking with the same compare-and-swap discipline as
 * BookingService::transition(), then release the old slot exactly like
 * BookingService::cancel_booking() does. Deliberately does not touch the
 * WooCommerce order — the minimum safe scope for this step is same
 * provider + same service + a different slot only, so price never changes
 * and `wp_bc_bookings.wc_order_id` is simply carried over untouched (see
 * task §10/§11). Service/provider changes, price changes, and any
 * cancellation-fee interaction are explicitly out of scope here —
 * NEEDS_BUSINESS_DECISION, not invented.
 */
final class RescheduleService {

	public const ACTOR_CUSTOMER = 'customer';
	public const ACTOR_PROVIDER = 'provider';
	public const ACTOR_ADMIN    = 'admin';

	/**
	 * NEEDS_BUSINESS_DECISION (task §5/§13) — provisional engineering
	 * defaults only, same "clearly labelled provisional, filterable"
	 * pattern as RebookingScheduler/RetentionScheduler's own defaults.
	 * Centralized here rather than scattered as magic numbers across
	 * controllers, per the task's own explicit instruction.
	 */
	public const DEFAULT_MAX_RESCHEDULES       = 2;
	public const DEFAULT_MIN_HOURS_BEFORE_SLOT = 6;

	public function max_reschedules(): int {
		return (int) apply_filters( 'beauclick/booking/max_reschedules', self::DEFAULT_MAX_RESCHEDULES );
	}

	public function min_hours_before(): int {
		return (int) apply_filters( 'beauclick/booking/reschedule_min_hours_before', self::DEFAULT_MIN_HOURS_BEFORE_SLOT );
	}

	public function reschedule_count( int $booking_id ): int {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_booking_reschedules WHERE booking_id = %d", $booking_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
	}

	/**
	 * Bulk variant of reschedule_count() for list views — a per-row query
	 * here would be exactly the N+1 pattern a prior production-readiness
	 * audit already found and fixed elsewhere in this codebase (Dashboard/
	 * Chat/Reviews controllers).
	 *
	 * @param list<int> $booking_ids
	 * @return array<int, int> booking_id => count
	 */
	public function counts_for( array $booking_ids ): array {
		if ( ! $booking_ids ) {
			return [];
		}
		global $wpdb;
		$placeholders = implode( ',', array_fill( 0, count( $booking_ids ), '%d' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT booking_id, COUNT(*) AS cnt FROM {$wpdb->prefix}bc_booking_reschedules WHERE booking_id IN ({$placeholders}) GROUP BY booking_id", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$booking_ids
			),
			ARRAY_A
		);
		$counts = [];
		foreach ( $rows ?: [] as $row ) {
			$counts[ (int) $row['booking_id'] ] = (int) $row['cnt'];
		}
		return $counts;
	}

	/**
	 * @param array<string, mixed> $booking
	 * @return array{eligible:bool, reason:?string, rescheduleCount:int, maxReschedules:int, minHoursBefore:int}
	 */
	public function eligibility( array $booking ): array {
		$count     = $this->reschedule_count( (int) $booking['id'] );
		$max       = $this->max_reschedules();
		$min_hours = $this->min_hours_before();

		$base = [
			'rescheduleCount' => $count,
			'maxReschedules'  => $max,
			'minHoursBefore'  => $min_hours,
		];

		if ( ! in_array( $booking['status'], [ BookingService::STATUS_PENDING, BookingService::STATUS_CONFIRMED ], true ) ) {
			return $base + [ 'eligible' => false, 'reason' => 'status' ];
		}

		if ( $count >= $max ) {
			return $base + [ 'eligible' => false, 'reason' => 'max_reached' ];
		}

		$hours_until = ( strtotime( (string) $booking['slot_start'] ) - strtotime( current_time( 'mysql' ) ) ) / HOUR_IN_SECONDS;
		if ( $hours_until < $min_hours ) {
			return $base + [ 'eligible' => false, 'reason' => 'too_close' ];
		}

		return $base + [ 'eligible' => true, 'reason' => null ];
	}

	/**
	 * @return array<string, mixed>|string Updated booking row on success, or
	 * one of: not_found|status|max_reached|too_close|same_slot|invalid_slot|
	 * slot_unavailable|conflict on failure — the REST controller maps each
	 * to a distinct Persian error + HTTP status.
	 */
	public function reschedule( int $booking_id, int $new_slot_id, int $actor_id, string $reason = '' ) {
		global $wpdb;

		$booking = ( new BookingService() )->find( $booking_id );
		if ( ! $booking ) {
			return 'not_found';
		}

		$this->log_event( 'booking_reschedule_requested', $booking_id, $actor_id, [ 'new_slot_id' => $new_slot_id ] );

		$eligibility = $this->eligibility( $booking );
		if ( ! $eligibility['eligible'] ) {
			$this->log_event( 'booking_reschedule_failed', $booking_id, $actor_id, [ 'reason' => $eligibility['reason'] ] );
			return $eligibility['reason'];
		}

		$old_slot_id = (int) $booking['slot_id'];
		if ( $new_slot_id === $old_slot_id ) {
			$this->log_event( 'booking_reschedule_failed', $booking_id, $actor_id, [ 'reason' => 'same_slot' ] );
			return 'same_slot';
		}

		$slots_table = $wpdb->prefix . 'bc_availability_slots';
		$new_slot    = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$slots_table} WHERE id = %d", $new_slot_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		if ( ! $new_slot
			|| (int) $new_slot['provider_id'] !== (int) $booking['provider_id']
			|| ( $booking['service_id'] && $new_slot['service_id'] && (int) $new_slot['service_id'] !== (int) $booking['service_id'] )
		) {
			// Minimum safe V2.2 Step 15 scope (task §10): same booking, same
			// provider, same service — only the slot may change. A service
			// or provider change is NEEDS_BUSINESS_DECISION, not built here.
			$this->log_event( 'booking_reschedule_failed', $booking_id, $actor_id, [ 'reason' => 'invalid_slot' ] );
			return 'invalid_slot';
		}

		$now        = current_time( 'mysql' );
		$held_until = gmdate( 'Y-m-d H:i:s', strtotime( $now ) + BookingService::HOLD_MINUTES * MINUTE_IN_SECONDS );

		// Step 1 — reserve the NEW slot first, the identical atomic claim
		// BookingService::create_booking() uses. Nothing about the original
		// booking has been touched yet, so a failure here leaves it
		// completely valid — the task's own "never leave a customer without
		// a booking because of a race condition" requirement (§8/§9).
		$claimed = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$slots_table}
				 SET status = 'held', held_until = %s
				 WHERE id = %d AND provider_id = %d
				   AND ( status = 'open' OR ( status = 'held' AND held_until < %s ) )", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$held_until,
				$new_slot_id,
				$booking['provider_id'],
				$now
			)
		);

		if ( ! $claimed ) {
			$this->log_event( 'booking_reschedule_failed', $booking_id, $actor_id, [ 'reason' => 'slot_unavailable' ] );
			return 'slot_unavailable';
		}

		// Step 2 — atomically move the booking, re-checking status hasn't
		// changed since eligibility was computed above (e.g. cancelled, or
		// a concurrent reschedule already won, in the window between
		// find() and here).
		$bookings_table = $wpdb->prefix . 'bc_bookings';
		$update_fields  = [
			'slot_id'    => $new_slot_id,
			'slot_start' => $new_slot['start_at'],
			'slot_end'   => $new_slot['end_at'],
			'updated_at' => $now,
		];
		if ( BookingService::STATUS_PENDING === $booking['status'] ) {
			// The booking's own hold must expire alongside the new slot's
			// hold — otherwise a still-pending reschedule would be swept
			// away on the OLD hold's original timer regardless of which
			// slot it now points to.
			$update_fields['expires_at'] = $held_until;
		}

		$set_sql = implode( ', ', array_map( static fn( string $col ): string => "{$col} = %s", array_keys( $update_fields ) ) );
		$moved   = $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$bookings_table} SET {$set_sql} WHERE id = %d AND status = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( array_values( $update_fields ), [ $booking_id, $booking['status'] ] )
			)
		);

		if ( ! $moved ) {
			// Roll back the new slot claim — the booking is no longer in
			// the state we verified it in, so nothing must be left holding
			// a slot on its behalf.
			$wpdb->update( $slots_table, [ 'status' => 'open', 'held_until' => null ], [ 'id' => $new_slot_id ] );
			$this->log_event( 'booking_reschedule_failed', $booking_id, $actor_id, [ 'reason' => 'conflict' ] );
			return 'conflict';
		}

		// Step 3 — an already-confirmed booking's new slot must become
		// permanently 'booked' the same way confirm_booking() does it; a
		// still-pending booking's new slot correctly stays 'held' until
		// payment confirms it.
		if ( BookingService::STATUS_CONFIRMED === $booking['status'] ) {
			$wpdb->update( $slots_table, [ 'status' => 'booked', 'held_until' => null ], [ 'id' => $new_slot_id ] );
		}

		// Step 4 — release the OLD slot. Safe unconditionally: the CAS
		// above already proved we still legitimately owned this booking at
		// the moment we moved it.
		$wpdb->update( $slots_table, [ 'status' => 'open', 'held_until' => null ], [ 'id' => $old_slot_id ] );

		$actor_role = $this->resolve_actor_role( $booking, $actor_id );
		$wpdb->insert(
			$wpdb->prefix . 'bc_booking_reschedules',
			[
				'booking_id'     => $booking_id,
				'old_slot_id'    => $old_slot_id,
				'new_slot_id'    => $new_slot_id,
				'old_slot_start' => $booking['slot_start'],
				'old_slot_end'   => $booking['slot_end'],
				'new_slot_start' => $new_slot['start_at'],
				'new_slot_end'   => $new_slot['end_at'],
				'actor_id'       => $actor_id,
				'actor_role'     => $actor_role,
				'reason'         => '' !== $reason ? $reason : null,
				'created_at'     => $now,
			]
		);

		// Same authoritative "slot newly available" moment as
		// BookingService::cancel_booking() — the freed OLD slot is a
		// genuine new opportunity for Waitlist, fired with the pre-move
		// values captured above, exactly mirroring that method's own call
		// shape and idempotency-key scoping (keyed to THIS slot id).
		do_action( 'beauclick/booking/slot_opened', $old_slot_id, (int) $booking['provider_id'], $booking['service_id'] ? (int) $booking['service_id'] : null, substr( (string) $booking['slot_start'], 0, 10 ) );

		// A reminder already sent for the OLD appointment time must not
		// silently suppress a genuinely new reminder for the NEW time —
		// ReminderScheduler's idempotency key has no time component, so
		// the stale delivery record is explicitly cleared rather than left
		// to block re-delivery via notify()'s own duplicate guard.
		if ( function_exists( 'beauclick_notifications' ) ) {
			beauclick_notifications()->invalidate(
				\BeauClick\Notifications\Templates\TemplateRegistry::BOOKING_REMINDER,
				'booking',
				$booking_id,
				(int) $booking['customer_id']
			);
		}

		$updated_booking = ( new BookingService() )->find( $booking_id );

		// Transactional, never-suppressible confirmation — same reasoning
		// and same wp_mail()-direct, preference-bypassing lineage as
		// BookingMailer::send_confirmed()/send_cancelled() (booking
		// lifecycle mail stays outside the togglable NotificationService
		// preference system by design).
		( new BookingMailer() )->send_rescheduled( $booking, $updated_booking, $actor_id );

		$this->log_event(
			'booking_reschedule_succeeded',
			$booking_id,
			$actor_id,
			[ 'old_slot_id' => $old_slot_id, 'new_slot_id' => $new_slot_id, 'actor_role' => $actor_role ]
		);

		return $updated_booking;
	}

	/** @return array<int, array<string, mixed>> */
	public function history( int $booking_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_booking_reschedules WHERE booking_id = %d ORDER BY created_at DESC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$booking_id
			),
			ARRAY_A
		);
		return array_map(
			static fn ( array $r ): array => [
				'id'           => (int) $r['id'],
				'oldSlotStart' => $r['old_slot_start'],
				'oldSlotEnd'   => $r['old_slot_end'],
				'newSlotStart' => $r['new_slot_start'],
				'newSlotEnd'   => $r['new_slot_end'],
				'actorRole'    => $r['actor_role'],
				'reason'       => $r['reason'],
				'createdAt'    => $r['created_at'],
			],
			$rows ?: []
		);
	}

	/** @param array<string, mixed> $booking */
	private function resolve_actor_role( array $booking, int $actor_id ): string {
		if ( $actor_id === (int) $booking['customer_id'] ) {
			return self::ACTOR_CUSTOMER;
		}
		if ( ProviderLookup::for_user( $actor_id ) === (int) $booking['provider_id'] ) {
			return self::ACTOR_PROVIDER;
		}
		return self::ACTOR_ADMIN;
	}

	private function log_event( string $type, int $booking_id, int $actor_id, array $meta = [] ): void {
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( $type, 'booking', $booking_id, $actor_id ?: null, $meta );
		}
	}
}
