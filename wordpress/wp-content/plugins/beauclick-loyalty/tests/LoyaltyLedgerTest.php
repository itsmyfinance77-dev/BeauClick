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
}
