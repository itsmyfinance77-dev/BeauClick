<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Waitlist;

/** Mirrors HoldExpiryScheduler/MembershipExpiryScheduler's own WP-Cron pattern -- daily sweep expiring waitlist entries past their expires_at. */
final class WaitlistExpiryScheduler {

	public const HOOK = 'beauclick_booking_expire_waitlist';

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
		( new WaitlistService() )->expire_due();
	}
}
