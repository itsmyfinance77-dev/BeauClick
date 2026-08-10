<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Database\Migration;
use BeauClick\Core\Database\Migrator;
use WP_UnitTestCase;

final class MigratorTest extends WP_UnitTestCase {

	public function test_a_migration_only_runs_once(): void {
		global $wpdb;

		$run_count = 0;
		$migration = new class( $run_count ) implements Migration {
			public function __construct( private int &$run_count ) {}
			public function id(): string {
				return 'test_migration_runs_once';
			}
			public function up(): void {
				++$this->run_count;
			}
		};

		$migrator = new Migrator();
		$migrator->register( 'test-group', [ $migration ] );

		$migrator->run_group( 'test-group' );
		$migrator->run_group( 'test-group' ); // Second call must be a no-op.

		$this->assertSame( 1, $run_count, 'Migration up() should only execute once, regardless of how many times run_group() is called.' );

		$ledger_id = 'test-group:test_migration_runs_once';
		$found     = $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . Migrator::ledger_table() . ' WHERE id = %s', $ledger_id ) );
		$this->assertSame( $ledger_id, $found, 'A successful migration must be recorded in the ledger.' );
	}

	public function test_a_failing_migration_is_not_recorded_as_applied(): void {
		global $wpdb;

		$migration = new class() implements Migration {
			public function id(): string {
				return 'test_migration_fails';
			}
			public function up(): void {
				throw new \RuntimeException( 'boom' );
			}
		};

		$migrator = new Migrator();
		$migrator->register( 'test-group', [ $migration ] );
		$migrator->run_group( 'test-group' );

		$ledger_id = 'test-group:test_migration_fails';
		$found     = $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . Migrator::ledger_table() . ' WHERE id = %s', $ledger_id ) );
		$this->assertNull( $found, 'A migration that throws must not be recorded as applied, so the next run retries it.' );
	}
}
