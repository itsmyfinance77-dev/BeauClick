<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Tests;

use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use WP_UnitTestCase;

final class LedgerServiceTest extends WP_UnitTestCase {

	public function set_up(): void {
		parent::set_up();
		CommissionConfig::set_rate( 15 ); // Deterministic for every test in this file, regardless of option state left by another test.
	}

	// 1. A real payment records exactly one commission row and one receivable row, correctly split.
	public function test_record_payment_splits_commission_and_receivable(): void {
		$service = new LedgerService();
		$ok      = $service->record_payment( 101, 201, LedgerService::PARTY_PROFESSIONAL, 11, 1000000 );

		$this->assertTrue( $ok );
		$entries = $service->for_order( 101 );
		$this->assertCount( 2, $entries );

		$commission = current( array_filter( $entries, static fn ( $e ) => 'commission' === $e['entryType'] ) );
		$receivable = current( array_filter( $entries, static fn ( $e ) => 'receivable' === $e['entryType'] ) );

		$this->assertSame( 150000, $commission['amount'], '15% of 1,000,000 must be exactly 150,000.' );
		$this->assertNull( $commission['partyId'] );
		$this->assertSame( LedgerService::PARTY_PLATFORM, $commission['partyType'] );

		$this->assertSame( 850000, $receivable['amount'] );
		$this->assertSame( 11, $receivable['partyId'] );
		$this->assertSame( LedgerService::PARTY_PROFESSIONAL, $receivable['partyType'] );

		$this->assertSame( 1000000, $commission['amount'] + $receivable['amount'], 'Commission + receivable must always sum to exactly the net amount -- no money invented or lost to rounding.' );
	}

	// 2. Idempotency: a retried payment-complete fire for the same order never double-records.
	public function test_record_payment_is_idempotent_per_order(): void {
		$service = new LedgerService();
		$service->record_payment( 102, 202, LedgerService::PARTY_PROFESSIONAL, 12, 500000 );
		$service->record_payment( 102, 202, LedgerService::PARTY_PROFESSIONAL, 12, 500000 ); // Simulated retry.

		$this->assertCount( 2, $service->for_order( 102 ), 'A retried payment-complete fire must never add a second commission/receivable pair.' );
	}

	// 3. A full refund reverses exactly the original split, using the ORIGINAL rate even if the platform rate changed since.
	public function test_record_refund_reverses_using_the_original_rate(): void {
		$service = new LedgerService();
		$service->record_payment( 103, 203, LedgerService::PARTY_BUSINESS, 13, 1000000 ); // 15% rate at time of payment.

		CommissionConfig::set_rate( 50 ); // Platform rate changes before the refund happens.

		$service->record_refund( 103, 9001, 1000000 );

		$net_commission = 0;
		$net_receivable = 0;
		foreach ( $service->for_order( 103 ) as $entry ) {
			if ( 'commission' === $entry['entryType'] ) {
				$net_commission += $entry['amount'];
			} else {
				$net_receivable += $entry['amount'];
			}
		}

		$this->assertSame( 0, $net_commission, 'A full refund must net the commission back to exactly zero, using the rate that was actually applied (15%), not the current one (50%).' );
		$this->assertSame( 0, $net_receivable );
	}

	// 4. A partial refund reverses only the refunded portion, leaving the rest intact.
	public function test_a_partial_refund_reverses_only_its_own_proportion(): void {
		$service = new LedgerService();
		$service->record_payment( 104, 204, LedgerService::PARTY_PROFESSIONAL, 14, 1000000 ); // commission 150,000 / receivable 850,000.

		$service->record_refund( 104, 9002, 200000 ); // Refund 20% of the order.

		// 200,000 refunded at the original 15% rate: commission reversal
		// -30,000, receivable reversal -170,000 (the two always sum to
		// exactly -refund_amount). 850,000 - 170,000 = 680,000.
		$this->assertSame( 680000, $service->order_receivable_net( 104 ) );
	}

	// 5. Refund idempotency: a retried refund-hook fire for the same refund id never double-reverses.
	public function test_record_refund_is_idempotent_per_refund(): void {
		$service = new LedgerService();
		$service->record_payment( 105, 205, LedgerService::PARTY_PROFESSIONAL, 15, 400000 );
		$service->record_refund( 105, 9003, 400000 );
		$service->record_refund( 105, 9003, 400000 ); // Simulated retry of the SAME refund id.

		$this->assertSame( 0, $service->order_receivable_net( 105 ), 'A retried refund fire for the same refund id must never over-reverse below zero.' );
	}

	// 6. A refund attempted with no prior recorded payment is a safe no-op (e.g. a race, or an order this ledger never scoped in).
	public function test_record_refund_is_a_noop_with_no_prior_payment(): void {
		$service = new LedgerService();
		$result  = $service->record_refund( 999, 9004, 100000 );

		$this->assertFalse( $result );
		$this->assertSame( [], $service->for_order( 999 ) );
	}

	// 7. Rounding: an odd total still splits commission+receivable to sum exactly, never losing or inventing a Toman.
	public function test_rounding_never_loses_or_invents_money(): void {
		CommissionConfig::set_rate( 15 );
		$service = new LedgerService();
		$service->record_payment( 106, 206, LedgerService::PARTY_PROFESSIONAL, 16, 333333 ); // 15% of 333,333 = 49,999.95.

		$entries    = $service->for_order( 106 );
		$commission = current( array_filter( $entries, static fn ( $e ) => 'commission' === $e['entryType'] ) );
		$receivable = current( array_filter( $entries, static fn ( $e ) => 'receivable' === $e['entryType'] ) );

		$this->assertSame( 333333, $commission['amount'] + $receivable['amount'] );
	}

	// 8. Zero and negative amounts are rejected -- never a zero-value or negative-value "payment" entry.
	public function test_record_payment_rejects_zero_or_negative_amounts(): void {
		$service = new LedgerService();
		$this->assertFalse( $service->record_payment( 107, 207, LedgerService::PARTY_PROFESSIONAL, 17, 0 ) );
		$this->assertFalse( $service->record_payment( 107, 207, LedgerService::PARTY_PROFESSIONAL, 17, -1000 ) );
		$this->assertSame( [], $service->for_order( 107 ) );
	}

	// 9. Cross-party isolation at the data layer: party_receivable_net() for one party never includes another's entries.
	public function test_party_receivable_net_is_isolated_per_party(): void {
		$service = new LedgerService();
		$service->record_payment( 108, 208, LedgerService::PARTY_PROFESSIONAL, 18, 1000000 );
		$service->record_payment( 109, 209, LedgerService::PARTY_PROFESSIONAL, 19, 2000000 );

		$this->assertSame( 850000, $service->party_receivable_net( LedgerService::PARTY_PROFESSIONAL, 18 ) );
		$this->assertSame( 1700000, $service->party_receivable_net( LedgerService::PARTY_PROFESSIONAL, 19 ) );
	}

	// 10. platform_totals() reflects real, live-summed commission across multiple orders.
	public function test_platform_totals_sums_commission_across_orders(): void {
		$service = new LedgerService();
		$service->record_payment( 110, 210, LedgerService::PARTY_PROFESSIONAL, 20, 1000000 );
		$service->record_payment( 111, 211, LedgerService::PARTY_BUSINESS, 21, 2000000 );

		$totals = $service->platform_totals();
		$this->assertSame( 450000, $totals['commission'] ); // 150,000 + 300,000.
		$this->assertGreaterThanOrEqual( 2, $totals['orderCount'] );
	}

	/**
	 * Both GAP-01 trigger tests below skip (not fail, not silently pass) when
	 * this DB user cannot create triggers -- confirmed a real, disclosed
	 * environment constraint on this local host (`CREATE TRIGGER` requires
	 * SUPER or `log_bin_trust_function_creators=1` with binary logging on;
	 * see `AddLedgerImmutabilityTriggers`'s own docblock). Asserting green
	 * here without the trigger actually present would be a false proof; a
	 * hard failure would misreport a hosting precondition as a code defect.
	 */
	private function skip_unless_ledger_triggers_exist(): void {
		global $wpdb;
		$triggers = $wpdb->get_col( "SHOW TRIGGERS WHERE `Table` = '{$wpdb->prefix}bc_ledger_entries'" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		if ( count( $triggers ) < 2 ) {
			self::markTestSkipped( 'wp_bc_ledger_entries immutability triggers are not present on this host (this DB user lacks CREATE TRIGGER privilege while binary logging is enabled) -- see AddLedgerImmutabilityTriggers\'s docblock. Code-layer immutability (no update/delete method exists on LedgerService) is unaffected.' );
		}
	}

	// 11. GAP-01: wp_bc_ledger_entries is genuinely append-only at the database layer, not just by LedgerService's own code discipline.
	public function test_a_direct_update_against_ledger_entries_is_blocked_at_the_database_layer(): void {
		$this->skip_unless_ledger_triggers_exist();
		global $wpdb;
		$service = new LedgerService();
		$service->record_payment( 112, 212, LedgerService::PARTY_PROFESSIONAL, 22, 400000 );
		$row_id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_ledger_entries WHERE order_id = %d AND entry_type = 'receivable' LIMIT 1", 112 ) );
		$this->assertGreaterThan( 0, $row_id );

		$wpdb->suppress_errors( true );
		$result = $wpdb->update( $wpdb->prefix . 'bc_ledger_entries', [ 'amount' => 1 ], [ 'id' => $row_id ] );
		$wpdb->suppress_errors( false );

		$this->assertFalse( $result, 'A raw UPDATE against wp_bc_ledger_entries must be rejected by the BEFORE UPDATE trigger, not silently succeed.' );
		$this->assertStringContainsString( 'append-only', (string) $wpdb->last_error );

		$unchanged = (int) $wpdb->get_var( $wpdb->prepare( "SELECT amount FROM {$wpdb->prefix}bc_ledger_entries WHERE id = %d", $row_id ) );
		$this->assertSame( 340000, $unchanged, 'The row must be completely unchanged after the blocked update attempt.' );
	}

	// 12. GAP-01: the same append-only guarantee blocks DELETE, not just UPDATE.
	public function test_a_direct_delete_against_ledger_entries_is_blocked_at_the_database_layer(): void {
		$this->skip_unless_ledger_triggers_exist();
		global $wpdb;
		$service = new LedgerService();
		$service->record_payment( 113, 213, LedgerService::PARTY_PROFESSIONAL, 23, 200000 );
		$row_id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_ledger_entries WHERE order_id = %d AND entry_type = 'commission' LIMIT 1", 113 ) );
		$this->assertGreaterThan( 0, $row_id );

		$wpdb->suppress_errors( true );
		$result = $wpdb->delete( $wpdb->prefix . 'bc_ledger_entries', [ 'id' => $row_id ] );
		$wpdb->suppress_errors( false );

		$this->assertFalse( $result, 'A raw DELETE against wp_bc_ledger_entries must be rejected by the BEFORE DELETE trigger, not silently succeed.' );
		$this->assertSame( 2, (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_ledger_entries WHERE order_id = %d", 113 ) ), 'Both rows recorded for this order must still exist.' );
	}

	// 13. GAP-05: the session-safe method returns exactly the current user's own receivable, never another party's.
	public function test_receivable_net_for_current_session_returns_the_real_current_users_own_receivable(): void {
		$owner_a = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_a = self::factory()->post->create( [ 'post_type' => \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_a ] );
		$owner_b = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_b = self::factory()->post->create( [ 'post_type' => \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_b ] );

		$service = new LedgerService();
		$service->record_payment( 501, 601, LedgerService::PARTY_PROFESSIONAL, $provider_a, 1000000 );
		$service->record_payment( 502, 602, LedgerService::PARTY_PROFESSIONAL, $provider_b, 5000000 );

		wp_set_current_user( $owner_a );
		$this->assertSame( 850000, $service->receivable_net_for_current_session(), "Professional A's own session must resolve to their own 15%-net figure, never professional B's." );

		wp_set_current_user( $owner_b );
		$this->assertSame( 4250000, $service->receivable_net_for_current_session() );
	}

	// 14. GAP-05: no argument this method accepts, because it accepts none -- there is nothing to spoof; it can only ever read the calling user's own party.
	public function test_receivable_net_for_current_session_is_null_with_no_provider_profile(): void {
		wp_set_current_user( self::factory()->user->create() );

		$this->assertNull( ( new LedgerService() )->receivable_net_for_current_session() );
	}

	// 15. GAP-05: a logged-out call resolves to null, never a fatal error or a real party's data.
	public function test_receivable_net_for_current_session_is_null_when_logged_out(): void {
		wp_set_current_user( 0 );

		$this->assertNull( ( new LedgerService() )->receivable_net_for_current_session() );
	}
}
