<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Retention;

/**
 * V2.1 Step 10 — deterministic retention automation, not campaign
 * segmentation (§24's explicit "future Campaign Engine will own broader
 * promotional targeting" boundary). "Inactive" is architecturally defined
 * as: last completed booking (any provider) older than a configurable
 * window, AND no upcoming (pending/confirmed) booking at all -- §25's own
 * suggested definition, made configurable rather than one hardcoded
 * universal number.
 *
 * Frequency-capped to at most once per calendar month per customer via
 * the notification idempotency key itself (`retention_cycle_{YYYY-MM}`) —
 * no extra "last nudged" column needed; a customer who becomes eligible
 * again next month gets a fresh, distinct idempotency key naturally.
 */
final class RetentionScheduler {

	public const HOOK = 'beauclick_booking_retention_sweep';

	/** NEEDS_BUSINESS_DECISION -- see RebookingScheduler::DEFAULT_INTERVAL_DAYS's own docblock for the same reasoning; 60 days is a provisional development default, overridable via the `beauclick/booking/inactivity_days` filter, never presented as final policy. */
	public const DEFAULT_INACTIVITY_DAYS = 60;

	public function register(): void {
		add_action( self::HOOK, [ $this, 'run' ] );
	}

	public function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time(), 'daily', self::HOOK );
		}
	}

	public function unschedule(): void {
		wp_clear_scheduled_hook( self::HOOK );
	}

	public function run(): void {
		if ( ! function_exists( 'beauclick_notifications' ) ) {
			return;
		}

		global $wpdb;
		$now    = current_time( 'mysql' );
		$cutoff = gmdate( 'Y-m-d H:i:s', strtotime( $now ) - $this->inactivity_days() * DAY_IN_SECONDS );

		// One aggregate query for every candidate, not a per-customer scan
		// -- §36's explicit "avoid scanning all customers... use
		// aggregation" instruction. Bounded to 500 candidates per run so a
		// large backlog can't turn one cron tick into an unbounded job.
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT customer_id, MAX(slot_start) AS last_visit
				 FROM {$wpdb->prefix}bc_bookings
				 WHERE status = 'completed'
				 GROUP BY customer_id
				 HAVING MAX(slot_start) <= %s
				 LIMIT 500", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$cutoff
			),
			ARRAY_A
		);

		$bucket = current_time( 'Y-m' );

		foreach ( $rows ?: [] as $row ) {
			$customer_id = (int) $row['customer_id'];

			$has_upcoming = $wpdb->get_var(
				$wpdb->prepare( "SELECT 1 FROM {$wpdb->prefix}bc_bookings WHERE customer_id = %d AND status IN ('pending','confirmed') LIMIT 1", $customer_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			);
			if ( $has_upcoming ) {
				continue; // A real, correct "no false positive" guard -- already has something on the calendar.
			}

			$customer = get_userdata( $customer_id );

			beauclick_notifications()->notify(
				\BeauClick\Notifications\Preferences\PreferenceService::CATEGORY_RETENTION,
				\BeauClick\Notifications\Templates\TemplateRegistry::RETENTION_NUDGE,
				$customer_id,
				[
					'customerName' => $customer ? $customer->display_name : '',
					'bookingUrl'   => home_url( '/marketplace/' ),
				],
				'retention_cycle_' . $bucket,
				$customer_id,
				[ 'sms', 'email' ]
			);
		}
	}

	private function inactivity_days(): int {
		return (int) apply_filters( 'beauclick/booking/inactivity_days', self::DEFAULT_INACTIVITY_DAYS );
	}
}
