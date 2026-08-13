<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Cron;

use BeauClick\Notifications\NotificationService;

/**
 * Bounded retry sweep for transient delivery failures -- mirrors
 * beauclick-booking's own HoldExpiryScheduler/MembershipExpiryScheduler
 * WP-Cron pattern exactly (§37's own "choose the best scheduler pattern"
 * instruction, and every existing scheduler in this codebase already uses
 * WP-Cron, not a new infrastructure platform).
 */
final class RetrySweepScheduler {

	public const HOOK = 'beauclick_notifications_retry';

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
		( new NotificationService() )->retry_failed();
	}
}
