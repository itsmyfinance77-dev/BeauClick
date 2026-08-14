<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\DataRequests;

/**
 * Thin CRUD layer over wp_bc_data_requests — every state transition for
 * both export and deletion requests goes through here, so ExportService/
 * DeletionService/PrivacyRequestsPage never write to the table directly.
 */
final class DataRequestService {

	public const TYPE_EXPORT   = 'export';
	public const TYPE_DELETION = 'deletion';

	// Export-only statuses.
	public const STATUS_READY   = 'ready';
	public const STATUS_EXPIRED = 'expired';
	public const STATUS_FAILED  = 'failed';

	// Deletion-only statuses.
	public const STATUS_PENDING    = 'pending'; // Awaiting admin review.
	public const STATUS_APPROVED   = 'approved'; // Admin approved; awaiting the processing sweep.
	public const STATUS_PROCESSING = 'processing';
	public const STATUS_COMPLETED  = 'completed';
	public const STATUS_REJECTED   = 'rejected';
	public const STATUS_BLOCKED    = 'blocked'; // A real conflicting state (upcoming booking, active paid membership, ...) was found.
	public const STATUS_CANCELLED  = 'cancelled'; // The customer withdrew their own still-pending request.

	/** @return array<string, mixed>|null The row a table matches, if any (in a given set of statuses). */
	public function latest_for_user( int $user_id, string $type, array $statuses = [] ): ?array {
		global $wpdb;
		$where  = 'user_id = %d AND request_type = %s';
		$params = [ $user_id, $type ];
		if ( $statuses ) {
			$placeholders = implode( ',', array_fill( 0, count( $statuses ), '%s' ) );
			$where       .= " AND status IN ({$placeholders})";
			$params       = array_merge( $params, $statuses );
		}
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE {$where} ORDER BY id DESC LIMIT 1", $params ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
			ARRAY_A
		);
		return $row ?: null;
	}

	public function find( int $id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	/** @return array<int, array<string, mixed>> */
	public function queue( string $type, array $statuses ): array {
		global $wpdb;
		$placeholders = implode( ',', array_fill( 0, count( $statuses ), '%s' ) );
		$params       = array_merge( [ $type ], $statuses );
		$rows         = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE request_type = %s AND status IN ({$placeholders}) ORDER BY requested_at ASC", $params ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
			ARRAY_A
		);
		return $rows ?: [];
	}

	/** @return array<int, array<string, mixed>> Bounded batch for a cron sweep — never an unbounded scan. */
	public function batch_with_status( string $type, string $status, int $limit ): array {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE request_type = %s AND status = %s ORDER BY id ASC LIMIT %d", $type, $status, $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return $rows ?: [];
	}

	public function create( int $user_id, string $type, string $status, ?string $reason = null ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_data_requests',
			[
				'user_id'      => $user_id,
				'request_type' => $type,
				'status'       => $status,
				'reason'       => $reason,
				'requested_at' => current_time( 'mysql' ),
			],
			[ '%d', '%s', '%s', '%s', '%s' ]
		);
		return $wpdb->insert_id;
	}

	/** @param array<string, mixed> $fields wpdb column => value */
	public function update( int $id, array $fields ): void {
		global $wpdb;
		$wpdb->update( $wpdb->prefix . 'bc_data_requests', $fields, [ 'id' => $id ] );
	}
}
