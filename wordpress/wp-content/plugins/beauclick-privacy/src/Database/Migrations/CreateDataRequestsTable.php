<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * One table for both request types (`export`/`deletion`) — per the
 * architecture plan's own explicit suggestion, avoiding two near-identical
 * tables for what is really one concept ("a customer asked this product to
 * do something with their own data, and we need to track that request's
 * lifecycle"). Columns not relevant to a given type stay NULL for that row
 * (export_token/export_file/expires_at for a deletion row; reviewed_by for
 * an export row, since exports are never admin-reviewed — only deletion
 * is, per this step's own explicit "not instant, irreversible
 * self-execution" design decision).
 */
final class CreateDataRequestsTable implements Migration {

	public function id(): string {
		return '2026_08_15_create_data_requests_table';
	}

	public function up(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = $wpdb->prefix . 'bc_data_requests';
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			user_id BIGINT UNSIGNED NOT NULL,
			request_type VARCHAR(20) NOT NULL,
			status VARCHAR(20) NOT NULL,
			reason VARCHAR(500) NULL,
			requested_at DATETIME NOT NULL,
			reviewed_at DATETIME NULL,
			reviewed_by BIGINT UNSIGNED NULL,
			completed_at DATETIME NULL,
			export_token VARCHAR(64) NULL,
			export_file VARCHAR(191) NULL,
			expires_at DATETIME NULL,
			last_error VARCHAR(500) NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY export_token (export_token),
			KEY user_type_status (user_id, request_type, status)
		) {$charset_collate};";

		dbDelta( $sql );
	}
}
