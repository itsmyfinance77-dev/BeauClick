<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\LoyaltyLedger;
use WP_UnitTestCase;

final class LoyaltyLedgerTest extends WP_UnitTestCase {

	public function test_a_new_users_balance_is_zero(): void {
		$user_id = self::factory()->user->create();
		$this->assertSame( 0, ( new LoyaltyLedger() )->balance( $user_id ) );
	}

	public function test_awarding_points_increases_the_balance(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 10, 'booking_completed', 'booking', 1 );
		$ledger->award( $user_id, 5, 'review_submitted', 'review', 2 );

		$this->assertSame( 15, $ledger->balance( $user_id ) );
	}

	public function test_negative_points_can_redeem_below_a_prior_balance(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 20, 'booking_completed' );
		$ledger->award( $user_id, -8, 'redeemed' );

		$this->assertSame( 12, $ledger->balance( $user_id ) );
	}

	public function test_balances_are_never_mixed_across_users(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		$ledger = new LoyaltyLedger();

		$ledger->award( $user_a, 100, 'booking_completed' );

		$this->assertSame( 100, $ledger->balance( $user_a ) );
		$this->assertSame( 0, $ledger->balance( $user_b ) );
	}

	public function test_history_returns_most_recent_entries_first(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 10, 'booking_completed' );
		$ledger->award( $user_id, 5, 'review_submitted' );

		$history = $ledger->history( $user_id );
		$this->assertSame( 'review_submitted', $history[0]['reason'] );
		$this->assertSame( 'booking_completed', $history[1]['reason'] );
	}

	/**
	 * V2.0 Step 1's idempotency check — the fast-path half of "never award
	 * twice for the same eligible event" (see AddLoyaltyReferenceUniqueIndex
	 * for the hard, DB-enforced half).
	 */
	public function test_has_awarded_is_false_before_and_true_after(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$this->assertFalse( $ledger->has_awarded( 'booking', 5, 'booking_completed' ) );

		$ledger->award( $user_id, 10, 'booking_completed', 'booking', 5 );

		$this->assertTrue( $ledger->has_awarded( 'booking', 5, 'booking_completed' ) );
	}

	public function test_has_awarded_is_scoped_to_the_exact_reference_and_reason(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();
		$ledger->award( $user_id, 10, 'booking_completed', 'booking', 5 );

		$this->assertFalse( $ledger->has_awarded( 'booking', 5, 'some_other_reason' ), 'A different reason for the same reference must not read as already awarded.' );
		$this->assertFalse( $ledger->has_awarded( 'booking', 6, 'booking_completed' ), 'A different reference_id must not read as already awarded.' );
		$this->assertFalse( $ledger->has_awarded( 'review', 5, 'booking_completed' ), 'A different reference_type must not read as already awarded.' );
	}

	/**
	 * The hard guarantee: even if application code somehow attempted a
	 * second award for the same (reference_type, reference_id, reason), the
	 * UNIQUE index added by AddLoyaltyReferenceUniqueIndex makes the second
	 * insert a no-op at the database layer — the balance must reflect only
	 * the first award, and award() itself must not throw.
	 */
	public function test_a_duplicate_reference_and_reason_is_rejected_at_the_database_layer(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 10, 'booking_completed', 'booking', 42 );
		$ledger->award( $user_id, 10, 'booking_completed', 'booking', 42 ); // Simulates a race that slipped past has_awarded().

		$this->assertSame( 10, $ledger->balance( $user_id ), 'A duplicate (reference_type, reference_id, reason) must never be double-counted in the balance.' );
	}

	public function test_rows_with_no_reference_are_never_blocked_by_the_unique_index(): void {
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 20, 'manual_adjustment' );
		$ledger->award( $user_id, 30, 'manual_adjustment' );

		$this->assertSame( 50, $ledger->balance( $user_id ), 'Reference-less awards (e.g. a future manual admin adjustment) must never collide under the unique index — NULL is distinct from NULL.' );
	}
}
