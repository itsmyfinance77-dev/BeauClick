<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Export;

use BeauClick\Privacy\DataRequests\DataRequestService;

/**
 * §13's own "exports must not be stored forever" requirement, enforced by
 * an actual sweep rather than only a client-side expiry check — the file
 * itself is deleted from disk, not just the database row marked stale.
 * Same register()/ensure_scheduled()/unschedule()/run() shape every other
 * WP-Cron job in this codebase already uses (RetrySweepScheduler etc.).
 */
final class ExportCleanupScheduler {

	public const HOOK = 'beauclick_privacy_export_cleanup';

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
		$requests = new DataRequestService();
		$storage  = new ExportStorage();

		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, export_file FROM {$wpdb->prefix}bc_data_requests WHERE request_type = %s AND status = %s AND expires_at IS NOT NULL AND expires_at < %s LIMIT 200", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				DataRequestService::TYPE_EXPORT,
				DataRequestService::STATUS_READY,
				current_time( 'mysql' )
			),
			ARRAY_A
		);

		foreach ( $rows ?: [] as $row ) {
			if ( ! empty( $row['export_file'] ) ) {
				$storage->delete( (string) $row['export_file'] );
			}
			$requests->update( (int) $row['id'], [ 'status' => DataRequestService::STATUS_EXPIRED, 'export_file' => null, 'export_token' => null ] );
		}
	}
}
