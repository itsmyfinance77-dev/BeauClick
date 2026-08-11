<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Cron;

use BeauClick\Booking\Booking\BookingService;

/**
 * Periodic sweep that cancels abandoned pending bookings and releases their
 * held slots. This is the backstop, not the primary defense — the atomic
 * slot claim in BookingService::create_booking() already treats an
 * expired-but-not-yet-swept 'held' slot as bookable in real time (so a
 * customer is never blocked by cron timing), but the ABANDONED booking
 * record itself still needs to be cancelled explicitly, which only this
 * sweep does. WP-Cron only fires on page load, which is unreliable at low
 * traffic (architecture doc §25) — acceptable here because a few extra
 * minutes of an already-expired hold sitting around before the next
 * visitor triggers WP-Cron has no real consequence; production should
 * still point a real system cron at wp-cron.php per that doc.
 */
final class HoldExpiryScheduler {

	public const HOOK = 'beauclick_booking_expire_holds';

	public function register(): void {
		add_filter( 'cron_schedules', [ $this, 'add_schedule' ] );
		add_action( self::HOOK, [ $this, 'run' ] );
	}

	public function add_schedule( array $schedules ): array {
		$schedules['bc_five_minutes'] = [
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 5 Minutes (BeauClick)', 'beauclick-booking' ),
		];
		return $schedules;
	}

	public function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time(), 'bc_five_minutes', self::HOOK );
		}
	}

	public function unschedule(): void {
		wp_clear_scheduled_hook( self::HOOK );
	}

	public function run(): void {
		( new BookingService() )->expire_stale_holds();
	}
}
