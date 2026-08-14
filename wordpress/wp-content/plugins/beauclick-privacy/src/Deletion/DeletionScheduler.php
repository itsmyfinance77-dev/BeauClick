<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Deletion;

use BeauClick\Privacy\DataRequests\DataRequestService;

/**
 * §31/§32 — deletion runs as a bounded, resumable WP-Cron sweep, not
 * synchronously inside the admin's own approval request. Same
 * register()/ensure_scheduled()/unschedule()/run() shape every other
 * scheduler in this codebase already uses. Every-15-minutes, not hourly —
 * a deletion an admin just approved shouldn't sit for up to an hour before
 * anything visibly happens, but this is still a real product decision an
 * operator can observe (the request's own "processing" status), not a
 * promise of near-instant completion.
 */
final class DeletionScheduler {

	public const HOOK = 'beauclick_privacy_process_deletions';

	/** Bounded per run, same "never scan/process an unbounded backlog in one tick" discipline as every other sweep in this codebase. */
	private const BATCH_SIZE = 20;

	public function register(): void {
		add_filter( 'cron_schedules', [ $this, 'add_schedule' ] ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected
		add_action( self::HOOK, [ $this, 'run' ] );
	}

	/** Same registration pattern as beauclick-booking's own HoldExpiryScheduler::add_schedule(). */
	public function add_schedule( array $schedules ): array {
		$schedules['bc_fifteen_minutes'] = [
			'interval' => 15 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 15 Minutes (BeauClick)', 'beauclick-privacy' ),
		];
		return $schedules;
	}

	public function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time(), 'bc_fifteen_minutes', self::HOOK );
		}
	}

	public function unschedule(): void {
		wp_clear_scheduled_hook( self::HOOK );
	}

	public function run(): void {
		$requests = new DataRequestService();
		$service  = new DeletionService();

		$batch = $requests->batch_with_status( DataRequestService::TYPE_DELETION, DataRequestService::STATUS_APPROVED, self::BATCH_SIZE );

		foreach ( $batch as $row ) {
			// Each request processed independently -- one failure (caught
			// inside DeletionService::process() itself) must never block the
			// rest of the batch.
			$service->process( (int) $row['id'] );
		}
	}
}
