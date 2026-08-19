<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Database\Migrations;

use BeauClick\Core\Database\Migration;

/**
 * V2.4 Step 26 (part 2), GAP-01. `LedgerService` already never issues an
 * UPDATE/DELETE against `wp_bc_ledger_entries` -- every correction (e.g. a
 * refund) is its own new INSERT row (see `record_refund()`'s own docblock),
 * so code-level immutability already holds by convention. This migration
 * closes the real remaining gap: nothing at the database layer stopped a
 * raw `$wpdb->update()`/`$wpdb->delete()` call elsewhere, a future careless
 * migration, or a direct database-tool edit from silently rewriting a
 * financial fact after it was recorded. Two BEFORE-triggers make the table
 * genuinely append-only regardless of which code path (or human) attempts
 * the mutation -- the same enforcement a revoked UPDATE/DELETE grant would
 * give, without this codebase needing a second, separately-privileged
 * database user (no such infrastructure exists here; WordPress itself always
 * connects as a single, fully-privileged DB_USER).
 *
 * Disclosed deployment precondition, found by actually running this
 * migration rather than assuming it would work: CREATE TRIGGER requires
 * either the SUPER privilege or the server variable
 * `log_bin_trust_function_creators = 1` whenever binary logging is enabled
 * (a MySQL/MariaDB replication-safety rule, not specific to this codebase).
 * A least-privilege application DB user -- confirmed to be exactly this
 * local environment's own DB_USER setup, GRANT ALL scoped only to its own
 * two schemas, no global/SUPER grant -- has this statement rejected. `up()`
 * checks each result explicitly and logs a clear, actionable message rather
 * than silently leaving the code believing it's enforced when it isn't; it
 * does not throw, so a restricted host's migration run still completes
 * normally. Same "hosting must be configured, this cannot self-elevate its
 * own privileges" category as the SMS/SMTP/payment-gateway credentials
 * PRODUCT_GAP_REGISTER.md already documents as required-before-production,
 * not a defect in this migration.
 */
final class AddLedgerImmutabilityTriggers implements Migration {

	public function id(): string {
		return '2026_08_19_add_ledger_immutability_triggers';
	}

	public function up(): void {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_ledger_entries';

		// DROP + CREATE (not "IF NOT EXISTS", which CREATE TRIGGER does not
		// support) keeps this idempotent if ever re-run outside the ledger.
		$wpdb->query( "DROP TRIGGER IF EXISTS bc_ledger_entries_no_update" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$wpdb->query( "DROP TRIGGER IF EXISTS bc_ledger_entries_no_delete" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$update_ok = $wpdb->query(
			"CREATE TRIGGER bc_ledger_entries_no_update
			 BEFORE UPDATE ON {$table}
			 FOR EACH ROW
			 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'wp_bc_ledger_entries is append-only; rows cannot be updated once recorded.'" // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		$delete_ok = $wpdb->query(
			"CREATE TRIGGER bc_ledger_entries_no_delete
			 BEFORE DELETE ON {$table}
			 FOR EACH ROW
			 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'wp_bc_ledger_entries is append-only; rows cannot be deleted once recorded.'" // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		if ( false === $update_ok || false === $delete_ok ) {
			error_log( // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
				'BeauClick: wp_bc_ledger_entries immutability triggers could not be created (' . $wpdb->last_error . '). '
				. 'This DB user most likely lacks the SUPER privilege while binary logging is enabled. '
				. 'The ledger remains append-only at the CODE layer (LedgerService has no update/delete methods), '
				. 'but is not yet enforced at the DATABASE layer on this host. To close this: either grant SUPER to '
				. 'the application DB user, or have the hosting provider set log_bin_trust_function_creators = 1, '
				. 'then re-run this migration\'s up() once.'
			);
		}
	}
}
