<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Cron;

use BeauClick\Booking\Ranking\RankingEngine;

/**
 * Hourly full-table ranking recompute -- the safety net for signals that
 * drift without a discrete "something happened" event (recent-activity
 * decay, response-time/completion-rate rolling-window aging). Real-time
 * per-provider recomputation for actual events lives in Plugin::boot()'s
 * hook wiring instead (beauclick/marketplace/provider_indexed,
 * beauclick/booking/completed, beauclick/reviews/submitted) -- this sweep
 * only needs to run hourly, not on every page load, matching
 * Cron\HoldExpiryScheduler's exact pattern (add_filter('cron_schedules'),
 * wp_next_scheduled()/wp_schedule_event() idempotent re-arm, unschedule on
 * deactivate) one module over.
 */
final class RankingScheduler {

	public const HOOK = 'beauclick_booking_recompute_rankings';

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
		( new RankingEngine() )->recompute_all();
	}
}
