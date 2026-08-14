<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Availability;

/**
 * V2.2 Step 16 — before this class, `wp_bc_availability_slots` had exactly
 * one writer in the entire codebase: `DemoAvailabilitySeed` (a dev-only
 * `wp bc:seed` fixture). No REST route, no UI, no real code path let an
 * actual professional create a single bookable slot — confirmed by a
 * repo-wide grep before writing this file. That is a genuine, severe
 * operational gap ("can a professional realistically operate their day-to-
 * day activity" — this step's own central question): without this, no real
 * professional signing up today can ever receive a booking. This class is
 * the "genuinely necessary" minimum the task's own §7 explicitly allows —
 * concrete, materialized rows (matching the existing architecture's own
 * stated preference — see CreateBookingTables's migration docblock,
 * "materialize concrete slots... via the professional's own REST call
 * rather than a cron-driven recurrence engine," which is exactly this),
 * never a recurrence-rule engine or a calendar-sync integration.
 *
 * Every write here only ever touches 'open' slots — the atomic hold/claim
 * transitions themselves remain exclusively BookingService's own
 * responsibility (create_booking()/cancel_booking()/RescheduleService),
 * this class never reads or writes 'held'/'booked' status.
 */
final class AvailabilityService {

	private const MAX_BULK_DAYS      = 60;
	private const MIN_SLOT_MINUTES   = 10;
	private const MAX_SLOT_MINUTES   = 8 * 60;
	private const LIST_WINDOW_DAYS   = 60;

	public const ERROR_INVALID_RANGE  = 'invalid_range';
	public const ERROR_IN_PAST        = 'in_past';
	public const ERROR_OVERLAPS       = 'overlaps';

	/**
	 * @return array{id:int}|string
	 */
	public function create_slot( int $provider_id, string $start_at, string $end_at, ?int $service_id ) {
		if ( ! $this->is_valid_datetime( $start_at ) || ! $this->is_valid_datetime( $end_at ) || strtotime( $start_at ) >= strtotime( $end_at ) ) {
			return self::ERROR_INVALID_RANGE;
		}
		if ( strtotime( $start_at ) < strtotime( current_time( 'mysql' ) ) ) {
			return self::ERROR_IN_PAST;
		}
		if ( $this->overlaps( $provider_id, $start_at, $end_at ) ) {
			return self::ERROR_OVERLAPS;
		}

		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[
				'provider_id' => $provider_id,
				'service_id'  => $service_id,
				'start_at'    => $start_at,
				'end_at'      => $end_at,
				'status'      => 'open',
				'created_at'  => current_time( 'mysql' ),
			]
		);

		return [ 'id' => (int) $wpdb->insert_id ];
	}

	private function overlaps( int $provider_id, string $start_at, string $end_at ): bool {
		global $wpdb;
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT 1 FROM {$wpdb->prefix}bc_availability_slots
				 WHERE provider_id = %d AND status IN ('open','held','booked')
				   AND start_at < %s AND end_at > %s LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id,
				$end_at,
				$start_at
			)
		);
	}

	private function is_valid_datetime( string $value ): bool {
		return (bool) preg_match( '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $value );
	}

	/**
	 * A simple recurring-hours generator, not a rule engine: given a set of
	 * weekdays + a daily time window + a slot duration, materializes
	 * concrete 'open' rows for every matching day in [date_from, date_to] —
	 * bounded to MAX_BULK_DAYS so a mistyped/adversarial range can't
	 * generate an unbounded number of rows in one request. Idempotent:
	 * re-running with the same inputs skips any slot whose exact start_at
	 * already exists for this provider, so a professional can safely
	 * re-submit the same weekly pattern to extend coverage further out.
	 *
	 * @param list<int> $weekdays 0 (Sunday) - 6 (Saturday), PHP's own `date('w')` convention.
	 * @return array{created:int, skipped:int}|string
	 */
	public function bulk_generate( int $provider_id, array $weekdays, string $time_start, string $time_end, int $slot_minutes, string $date_from, string $date_to, ?int $service_id ) {
		if ( ! preg_match( '/^\d{2}:\d{2}$/', $time_start ) || ! preg_match( '/^\d{2}:\d{2}$/', $time_end ) || $time_start >= $time_end ) {
			return self::ERROR_INVALID_RANGE;
		}
		if ( $slot_minutes < self::MIN_SLOT_MINUTES || $slot_minutes > self::MAX_SLOT_MINUTES ) {
			return self::ERROR_INVALID_RANGE;
		}
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date_from ) || ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date_to ) || $date_from > $date_to ) {
			return self::ERROR_INVALID_RANGE;
		}
		if ( ( strtotime( $date_to ) - strtotime( $date_from ) ) / DAY_IN_SECONDS > self::MAX_BULK_DAYS ) {
			return self::ERROR_INVALID_RANGE;
		}
		$weekdays = array_values( array_intersect( array_map( 'intval', $weekdays ), range( 0, 6 ) ) );
		if ( ! $weekdays ) {
			return self::ERROR_INVALID_RANGE;
		}

		global $wpdb;
		$table   = $wpdb->prefix . 'bc_availability_slots';
		$now     = current_time( 'mysql' );
		$created = 0;
		$skipped = 0;

		$day = strtotime( $date_from );
		$end = strtotime( $date_to );
		while ( $day <= $end ) {
			$date = gmdate( 'Y-m-d', $day );
			if ( in_array( (int) gmdate( 'w', $day ), $weekdays, true ) ) {
				$slot_start = strtotime( "{$date} {$time_start}:00" );
				$window_end = strtotime( "{$date} {$time_end}:00" );

				while ( $slot_start + $slot_minutes * MINUTE_IN_SECONDS <= $window_end ) {
					$start_at = gmdate( 'Y-m-d H:i:s', $slot_start );
					$end_at   = gmdate( 'Y-m-d H:i:s', $slot_start + $slot_minutes * MINUTE_IN_SECONDS );

					if ( $slot_start < strtotime( $now ) ) {
						$slot_start += $slot_minutes * MINUTE_IN_SECONDS;
						continue; // Already-past slot on the first (today's) day -- silently skip, not an error.
					}

					$exists = (bool) $wpdb->get_var(
						$wpdb->prepare(
							"SELECT 1 FROM {$table} WHERE provider_id = %d AND start_at = %s LIMIT 1", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
							$provider_id,
							$start_at
						)
					);

					if ( $exists ) {
						++$skipped;
					} else {
						$wpdb->insert(
							$table,
							[
								'provider_id' => $provider_id,
								'service_id'  => $service_id,
								'start_at'    => $start_at,
								'end_at'      => $end_at,
								'status'      => 'open',
								'created_at'  => $now,
							]
						);
						++$created;
					}

					$slot_start += $slot_minutes * MINUTE_IN_SECONDS;
				}
			}
			$day += DAY_IN_SECONDS;
		}

		return [ 'created' => $created, 'skipped' => $skipped ];
	}

	/** @return array<int, array<string, mixed>> */
	public function list_own( int $provider_id ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, service_id, start_at, end_at, status FROM {$wpdb->prefix}bc_availability_slots
				 WHERE provider_id = %d AND start_at >= %s AND start_at < %s
				 ORDER BY start_at ASC LIMIT 500", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id,
				current_time( 'mysql' ),
				gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + self::LIST_WINDOW_DAYS * DAY_IN_SECONDS )
			),
			ARRAY_A
		);

		return array_map(
			static fn ( array $r ): array => [
				'id'        => (int) $r['id'],
				'serviceId' => $r['service_id'] ? (int) $r['service_id'] : null,
				'startAt'   => $r['start_at'],
				'endAt'     => $r['end_at'],
				'status'    => $r['status'],
			],
			$rows ?: []
		);
	}

	/** Only an 'open' slot may be deleted directly -- a held/booked slot backs a real, in-flight booking and must go through cancellation, never a silent delete. */
	public function delete_slot( int $provider_id, int $slot_id ): bool {
		global $wpdb;
		$affected = $wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d AND provider_id = %d AND status = 'open'", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$slot_id,
				$provider_id
			)
		);
		return (bool) $affected;
	}
}
