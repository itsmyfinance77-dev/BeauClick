<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Membership;

/**
 * Periodic sweep marking expired memberships `expired` -- mirrors
 * beauclick-booking's own HoldExpiryScheduler pattern exactly (a daily
 * WP-Cron event is more than sufficient here; membership expiry has none of
 * hold-expiry's real-time-availability urgency). WP-Cron only fires on page
 * load (architecture doc §25) -- acceptable for the same reason the booking
 * scheduler accepts it: a membership sitting a few hours past its real
 * expiry before the next visitor triggers WP-Cron has no urgent
 * consequence; production should still point a real system cron at
 * wp-cron.php.
 */
final class MembershipExpiryScheduler {

	public const HOOK = 'beauclick_loyalty_expire_memberships';

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
		( new MembershipService() )->expire_due();
	}
}
