<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Loyalty\Tiers\TierService;
use WP_UnitTestCase;

final class TierServiceTest extends WP_UnitTestCase {

	private function seed_tiers(): TierService {
		$service = new TierService();
		$service->create( 'base', 'پایه', 0 );
		$service->create( 'silver', 'نقره‌ای', 1000 );
		$service->create( 'gold', 'طلایی', 5000 );
		return $service;
	}

	// 1. Correct tier at threshold.
	public function test_a_customer_exactly_at_a_threshold_qualifies_for_that_tier(): void {
		$service = $this->seed_tiers();
		$tier    = $service->for_points( 1000 );
		$this->assertSame( 'silver', $tier['slug'], 'Reaching a threshold exactly must qualify -- >=, never >.' );
	}

	// 2. Correct tier below threshold.
	public function test_a_customer_one_point_below_a_threshold_does_not_qualify(): void {
		$service = $this->seed_tiers();
		$tier    = $service->for_points( 999 );
		$this->assertSame( 'base', $tier['slug'], '999 points must stay in the base tier, not silver -- no off-by-one.' );
	}

	// 5. Missing/zero points.
	public function test_zero_points_qualifies_for_the_zero_threshold_tier(): void {
		$service = $this->seed_tiers();
		$this->assertSame( 'base', $service->for_points( 0 )['slug'] );
	}

	public function test_zero_points_with_no_zero_threshold_tier_qualifies_for_nothing(): void {
		$service = new TierService();
		$service->create( 'silver', 'نقره‌ای', 1000 );

		$this->assertNull( $service->for_points( 0 ), 'A customer below every configured threshold must qualify for no tier, not the lowest one by default.' );
	}

	// 6. Large point balances.
	public function test_a_very_large_balance_qualifies_for_the_highest_tier(): void {
		$service = $this->seed_tiers();
		$this->assertSame( 'gold', $service->for_points( 1000000 )['slug'] );
	}

	// 3. Correct next-tier progress.
	public function test_progress_reports_the_correct_next_tier_and_points_remaining(): void {
		$this->seed_tiers();
		$user_id = self::factory()->user->create();
		( new LoyaltyLedger() )->award( $user_id, 600, 'booking_completed' );

		$progress = ( new TierService() )->progress_for_user( $user_id );

		$this->assertSame( 'base', $progress['currentTier']['slug'] );
		$this->assertSame( 'silver', $progress['nextTier']['slug'] );
		$this->assertSame( 400, $progress['pointsToNext'] );
		$this->assertEqualsWithDelta( 60.0, $progress['percentToNext'], 0.1 );
	}

	public function test_progress_for_the_highest_tier_has_no_next_tier(): void {
		$this->seed_tiers();
		$user_id = self::factory()->user->create();
		( new LoyaltyLedger() )->award( $user_id, 9000, 'booking_completed' );

		$progress = ( new TierService() )->progress_for_user( $user_id );

		$this->assertSame( 'gold', $progress['currentTier']['slug'] );
		$this->assertNull( $progress['nextTier'] );
		$this->assertNull( $progress['pointsToNext'] );
	}

	// 4. Tier recalculation -- never cached/stale, always derived fresh from the ledger.
	public function test_tier_is_recalculated_live_as_points_accumulate_not_cached(): void {
		$this->seed_tiers();
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();
		$service = new TierService();

		$this->assertSame( 'base', $service->progress_for_user( $user_id )['currentTier']['slug'] );

		$ledger->award( $user_id, 1000, 'booking_completed' );
		$this->assertSame( 'silver', $service->progress_for_user( $user_id )['currentTier']['slug'], 'A fresh award must immediately change the computed tier -- there is no cache to invalidate.' );
	}

	// Qualification uses LIFETIME EARNED, never the spendable balance -- a redemption must not demote.
	public function test_redeeming_points_does_not_demote_a_customers_tier(): void {
		$this->seed_tiers();
		$user_id = self::factory()->user->create();
		$ledger  = new LoyaltyLedger();

		$ledger->award( $user_id, 1000, 'booking_completed' );
		$ledger->award( $user_id, -900, 'redeemed' );

		$this->assertSame( 100, $ledger->balance( $user_id ) );
		$this->assertSame( 'silver', ( new TierService() )->progress_for_user( $user_id )['currentTier']['slug'], 'A tier must be based on lifetime EARNED points, not the current spendable balance -- redeeming points must never demote a tier.' );
	}

	public function test_an_inactive_tier_is_never_returned_as_qualifying(): void {
		$service = $this->seed_tiers();
		$silver  = $service->for_points( 1000 );
		$service->update( $silver['id'], [ 'isActive' => false ] );

		$this->assertSame( 'base', $service->for_points( 1000 )['slug'], 'A deactivated tier must be skipped even if its threshold is met.' );
	}

	public function test_updating_a_tiers_threshold_takes_effect_immediately(): void {
		$service = $this->seed_tiers();
		$silver  = $service->for_points( 1000 );
		$service->update( $silver['id'], [ 'thresholdPoints' => 2000 ] );

		$this->assertSame( 'base', $service->for_points( 1000 )['slug'], 'Raising a threshold must immediately affect qualification -- tiers are configuration, not a cached snapshot.' );
	}
}
