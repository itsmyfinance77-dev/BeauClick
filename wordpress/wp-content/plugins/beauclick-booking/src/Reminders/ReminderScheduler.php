<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Reminders;

use BeauClick\Core\Support\JalaliDate;

/**
 * V2.1 Step 10 (BOOK-05/DATE-03) — hourly sweep, no new table. A reminder
 * "job" doesn't need its own persisted row: `wp_bc_bookings` is already
 * the authoritative source of which bookings are genuinely confirmed and
 * upcoming (§19's own "use the existing booking/order lifecycle as source
 * of truth" instruction), and `wp_bc_notifications`' own idempotency key
 * (`booking_reminder:booking:{id}:...`) is what actually prevents a
 * duplicate — an hourly re-run naturally re-queries the same still-in-
 * window booking and the notification service just as naturally treats
 * the second attempt as a duplicate no-op.
 *
 * A 2-hour matching window (23h–25h out) around the 24h mark is
 * deliberately wider than the 1-hour cron cadence — a booking whose
 * slot_start lands between two cron runs must still fall inside at least
 * one window, never slip through entirely.
 *
 * Cancelled/expired/completed bookings are excluded structurally by the
 * `status = 'confirmed'` filter alone — no extra suppression logic needed.
 */
final class ReminderScheduler {

	public const HOOK = 'beauclick_booking_send_reminders';

	private const WINDOW_START_HOURS = 23;
	private const WINDOW_END_HOURS   = 25;

	public function register(): void {
		add_action( self::HOOK, [ $this, 'run' ] );
	}

	public function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time(), 'hourly', self::HOOK );
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
		$now          = current_time( 'mysql' ); // Site-local wall clock -- same idiom as every other booking-domain time calculation in this codebase.
		$window_start = gmdate( 'Y-m-d H:i:s', strtotime( $now ) + self::WINDOW_START_HOURS * HOUR_IN_SECONDS );
		$window_end   = gmdate( 'Y-m-d H:i:s', strtotime( $now ) + self::WINDOW_END_HOURS * HOUR_IN_SECONDS );

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, customer_id, provider_id, slot_start FROM {$wpdb->prefix}bc_bookings WHERE status = 'confirmed' AND slot_start BETWEEN %s AND %s LIMIT 200", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$window_start,
				$window_end
			),
			ARRAY_A
		);

		foreach ( $rows ?: [] as $row ) {
			$provider = get_post( (int) $row['provider_id'] );
			$customer = get_userdata( (int) $row['customer_id'] );

			beauclick_notifications()->notify(
				\BeauClick\Notifications\Preferences\PreferenceService::CATEGORY_REMINDER,
				\BeauClick\Notifications\Templates\TemplateRegistry::BOOKING_REMINDER,
				(int) $row['customer_id'],
				[
					'customerName' => $customer ? $customer->display_name : '',
					'providerName' => $provider ? $provider->post_title : __( 'متخصص', 'beauclick-booking' ),
					'when'         => JalaliDate::format( (string) $row['slot_start'], true ),
				],
				'booking',
				(int) $row['id'],
				[ 'sms', 'email' ]
			);
		}
	}
}
