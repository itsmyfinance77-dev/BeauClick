<?php
declare( strict_types=1 );

namespace BeauClick\Core\Database;

/**
 * Tracks and runs migrations across all beauclick-* plugins in a single
 * ledger table (wp_bc_migrations), so `wp bc:migrate` can bring any
 * environment up to date regardless of which plugins were reactivated when.
 *
 * Deliberately no cross-plugin foreign keys in the tables these migrations
 * create — WordPress does not guarantee plugin activation order, so
 * inter-plugin references (e.g. a booking's provider_id) are plain indexed
 * columns with integrity enforced in application code, not the schema.
 */
final class Migrator {

	/** @var array<string, Migration[]> */
	private array $groups = [];

	public static function ledger_table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bc_migrations';
	}

	/**
	 * Creates the ledger table itself. Must be called directly (not through
	 * run_group) before any migration can be recorded — bootstrapped from
	 * beauclick-core's own activation hook.
	 */
	public static function install_ledger(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table_name      = self::ledger_table();
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table_name} (
			id VARCHAR(191) NOT NULL,
			applied_at DATETIME NOT NULL,
			PRIMARY KEY  (id)
		) {$charset_collate};";

		dbDelta( $sql );
	}

	/**
	 * @param Migration[] $migrations
	 */
	public function register( string $group, array $migrations ): void {
		$this->groups[ $group ] = $migrations;
	}

	/** @return string[] Group slugs with at least one registered migration. */
	public function registered_groups(): array {
		return array_keys( $this->groups );
	}

	public function run_group( string $group ): void {
		if ( ! isset( $this->groups[ $group ] ) ) {
			return;
		}
		foreach ( $this->groups[ $group ] as $migration ) {
			$this->run_one( $group, $migration );
		}
	}

	public function run_all(): void {
		foreach ( array_keys( $this->groups ) as $group ) {
			$this->run_group( $group );
		}
	}

	private function run_one( string $group, Migration $migration ): void {
		global $wpdb;

		$id = $group . ':' . $migration->id();

		$table   = self::ledger_table();
		$already = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$table} WHERE id = %s", $id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		if ( $already ) {
			return;
		}

		try {
			$migration->up();
			$wpdb->insert(
				$table,
				[
					'id'         => $id,
					'applied_at' => current_time( 'mysql' ),
				]
			);
		} catch ( \Throwable $e ) {
			// A failed migration must not silently look "applied" — no ledger row is written,
			// so the next run_all() retries it. Surfaced loudly since a broken migration
			// blocks every plugin that depends on the table it was supposed to create.
			error_log( sprintf( '[BeauClick] migration "%s" failed: %s', $id, $e->getMessage() ) ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions
			if ( function_exists( 'do_action' ) ) {
				do_action( 'beauclick/core/migration_failed', $id, $e );
			}
		}
	}
}
