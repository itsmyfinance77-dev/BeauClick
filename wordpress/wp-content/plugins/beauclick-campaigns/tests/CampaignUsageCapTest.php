<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Tests;

use BeauClick\Campaigns\CampaignService;
use WP_UnitTestCase;

/**
 * V2.4 Step 26 (part 2), GAP-04: `CampaignService::record_usage_within_cap()`.
 *
 * This class does NOT need the manual per-test cleanup an earlier version of
 * this file required -- that version's production method used an explicit
 * `START TRANSACTION`/`COMMIT`, which silently committed `WP_UnitTestCase`'s
 * own per-test transaction wrapper (a real, reproduced problem: 20+ cascading
 * failures across unrelated test files the first time this was run against
 * the full suite, since `CampaignDiscount::apply()` calls this method on
 * every real booking-creation test that has an active campaign). The current
 * implementation is a single atomic `INSERT ... SELECT ... WHERE` statement
 * (see the method's own docblock) that needs no transaction of its own, so
 * it composes safely with the framework's normal per-test rollback, exactly
 * like every other write in this codebase.
 */
final class CampaignUsageCapTest extends WP_UnitTestCase {

	private function make_campaign( array $overrides = [] ): int {
		$service = new CampaignService();
		return $service->create(
			array_merge(
				[ 'name' => 'کمپین سقف مصرف', 'discountType' => CampaignService::TYPE_PERCENTAGE, 'discountValue' => 10 ],
				$overrides
			)
		)['id'];
	}

	// 1. Succeeds and inserts while genuinely under the total cap.
	public function test_record_usage_within_cap_succeeds_while_under_the_total_limit(): void {
		$service = new CampaignService();
		$id      = $this->make_campaign();

		$ok = $service->record_usage_within_cap( $id, 501, 901, 31, 5000, 3, null );

		$this->assertTrue( $ok );
		$this->assertSame( 1, $service->usage_count( $id ) );
	}

	// 2. Refuses once the total cap is already met, and never inserts the row.
	public function test_record_usage_within_cap_refuses_once_the_total_limit_is_reached(): void {
		$service = new CampaignService();
		$id      = $this->make_campaign( [ 'usageLimitTotal' => 2 ] );

		$this->assertTrue( $service->record_usage_within_cap( $id, 511, 911, 32, 1000, 2, null ) );
		$this->assertTrue( $service->record_usage_within_cap( $id, 512, 912, 33, 1000, 2, null ) );
		$refused = $service->record_usage_within_cap( $id, 513, 913, 34, 1000, 2, null );

		$this->assertFalse( $refused, 'A third usage attempt against a cap of 2 must be refused.' );
		$this->assertSame( 2, $service->usage_count( $id ), 'The refused attempt must never have been inserted.' );
	}

	// 3. The per-customer cap is enforced the same way, independently of the total cap.
	public function test_record_usage_within_cap_refuses_once_the_per_customer_limit_is_reached(): void {
		$service = new CampaignService();
		$id      = $this->make_campaign( [ 'usageLimitPerCustomer' => 1 ] );

		$this->assertTrue( $service->record_usage_within_cap( $id, 521, 921, 41, 1000, null, 1 ) );
		$refused          = $service->record_usage_within_cap( $id, 522, 922, 41, 1000, null, 1 ); // Same customer (41), a different booking.
		$another_customer = $service->record_usage_within_cap( $id, 523, 923, 42, 1000, null, 1 ); // A different customer must be unaffected.

		$this->assertFalse( $refused, 'The same customer must be refused a second usage once their per-customer cap of 1 is reached.' );
		$this->assertTrue( $another_customer, "A different customer must not be blocked by another customer's own cap." );
		$this->assertSame( 1, $service->usage_count( $id, 41 ) );
	}

	// 4. With no configured limit (null), the cap check is skipped entirely -- unlimited campaigns are unaffected by this guard.
	public function test_record_usage_within_cap_is_unbounded_when_no_limit_is_configured(): void {
		$service = new CampaignService();
		$id      = $this->make_campaign(); // No usageLimitTotal/usageLimitPerCustomer set.

		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertTrue( $service->record_usage_within_cap( $id, 600 + $i, 1000 + $i, 50, 1000, null, null ) );
		}
		$this->assertSame( 5, $service->usage_count( $id ) );
	}

	// 5. The existing UNIQUE(booking_id) idempotency guard survives unchanged inside the new single-statement form.
	public function test_record_usage_within_cap_still_refuses_a_repeated_booking_id_even_with_capacity_remaining(): void {
		$service = new CampaignService();
		$id      = $this->make_campaign( [ 'usageLimitTotal' => 10 ] ); // Plenty of capacity left -- the refusal must come from the booking_id, not the cap.

		$this->assertTrue( $service->record_usage_within_cap( $id, 700, 1100, 70, 1000, 10, null ) );
		$refused = $service->record_usage_within_cap( $id, 700, 1101, 70, 1000, 10, null ); // Same booking_id, different order_id.

		$this->assertFalse( $refused );
		$this->assertSame( 1, $service->usage_count( $id ) );
	}

	/**
	 * 6. The real, adversarial concurrency proof this fix exists for: THREE
	 * genuinely separate OS processes (real `proc_open()` child PHP
	 * processes, each opening its own MySQL connection -- the same shape
	 * three concurrent PHP-FPM workers would produce, not one PHP process
	 * simulating concurrency) dispatch the exact query
	 * `record_usage_within_cap()` issues, for the SAME campaign_id, at
	 * (as close to) the same time. Against a cap of 2, the row count actually
	 * persisted must NEVER exceed 2 -- proving this is real database-level
	 * mutual exclusion, not single-connection application logic that would
	 * still race across real concurrent requests. Deliberately asserts
	 * "never more than the cap," not "always exactly at the cap": MySQL's own
	 * deadlock detector is one of the two legitimate ways this guard can
	 * resolve a genuine three-way conflict (observed directly during
	 * development -- a losing racer's statement is aborted outright rather
	 * than blocking), which can leave fewer than the cap recorded from one
	 * race. That is an acceptable availability trade-off (a customer who
	 * loses a deadlock simply doesn't get the discount that attempt), never
	 * a correctness violation -- the cap is still never overshot.
	 */
	public function test_the_cap_is_never_exceeded_under_genuine_concurrent_load(): void {
		global $wpdb;
		$id  = $this->make_campaign( [ 'usageLimitTotal' => 2 ] );
		$now = current_time( 'mysql' );
		// booking_id/order_id are derived from the campaign's own freshly
		// auto-incremented $id (never from a static literal) -- a static
		// literal here would collide with a PRIOR run's own already-committed
		// rows (this test deliberately commits real rows via real separate
		// connections; see the class docblock) and get silently skipped by
		// wp_bc_campaign_usages' own UNIQUE(booking_id) constraint, which
		// looks identical to "the cap correctly refused it" but is actually
		// an unrelated collision -- a real bug this test hit during development.
		$booking_id_base = $id * 10;
		$order_id_base   = $id * 10 + 5000000;

		$racer_script = <<<'PHP'
<?php
[, $host, $user, $pass, $name, $prefix, $campaign_id, $booking_id, $order_id, $now] = $argv;
mysqli_report( MYSQLI_REPORT_OFF );
$mysqli = new mysqli( $host, $user, $pass, $name );
$sql = "INSERT IGNORE INTO {$prefix}bc_campaign_usages
        (campaign_id, booking_id, order_id, customer_id, discount_amount, status, created_at, updated_at)
        SELECT $campaign_id, $booking_id, $order_id, 90, 1000, 'applied', '$now', '$now'
        FROM DUAL
        WHERE (SELECT COUNT(*) FROM {$prefix}bc_campaign_usages WHERE campaign_id = $campaign_id AND status = 'applied') < 2";
$ok = $mysqli->query( $sql );
echo ( $ok && $mysqli->affected_rows > 0 ) ? 1 : 0;
PHP;

		$script_path = sys_get_temp_dir() . '/bc_usage_cap_racer_' . getmypid() . '.php';
		file_put_contents( $script_path, $racer_script );

		$php_binary = PHP_BINARY ?: 'php';
		$processes  = [];
		$pipes_list = [];
		for ( $i = 0; $i < 3; $i++ ) {
			$cmd = [ $php_binary, $script_path, DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, $wpdb->prefix, (string) $id, (string) ( $booking_id_base + $i ), (string) ( $order_id_base + $i ), $now ];
			$pipes = [];
			$proc  = proc_open( $cmd, [ 1 => [ 'pipe', 'w' ], 2 => [ 'pipe', 'w' ] ], $pipes );
			$this->assertIsResource( $proc, 'Failed to spawn the racer subprocess -- environment cannot run this concurrency proof.' );
			$processes[]  = $proc;
			$pipes_list[] = $pipes;
		}

		$succeeded = 0;
		foreach ( $processes as $i => $proc ) {
			$stdout = stream_get_contents( $pipes_list[ $i ][1] );
			fclose( $pipes_list[ $i ][1] );
			fclose( $pipes_list[ $i ][2] );
			proc_close( $proc );
			$succeeded += (int) trim( $stdout );
		}

		unlink( $script_path );

		$this->assertLessThanOrEqual( 2, $succeeded, 'No more than 2 of the 3 truly concurrent (separate-process) attempts may ever succeed against a cap of 2.' );
		$this->assertGreaterThan( 0, $succeeded, 'The guard must not be so restrictive that a genuine, uncontested slot never gets recorded at all.' );

		// Confirmed via a fresh, independent connection, not this test's own
		// $wpdb -- that connection's transaction (opened by WP_UnitTestCase's
		// set_up(), REPEATABLE READ by default) took its consistent snapshot
		// BEFORE the racer subprocesses committed, so it would never see
		// their real, already-committed rows; a genuinely new connection has
		// no such stale snapshot.
		$fresh = new \wpdb( DB_USER, DB_PASSWORD, DB_NAME, DB_HOST );
		$count = (int) $fresh->get_var( $fresh->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d AND status = 'applied'", $id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$fresh->close();

		$this->assertLessThanOrEqual( 2, $count, 'The persisted row count -- confirmed from a fresh connection with no stale snapshot -- must never exceed the cap, regardless of how the 3-way race resolved.' );
		$this->assertSame( $succeeded, $count, 'The persisted count must exactly match what the racers themselves reported succeeding -- no lost or phantom rows.' );
	}
}
