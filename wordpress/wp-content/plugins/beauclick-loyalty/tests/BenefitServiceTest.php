<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Loyalty\Tiers\TierService;
use WP_UnitTestCase;

final class BenefitServiceTest extends WP_UnitTestCase {

	// 9. Benefit eligibility.
	public function test_a_user_with_no_qualifying_tier_or_membership_has_the_default_multiplier_and_no_discount(): void {
		$user_id = self::factory()->user->create();
		$service = new BenefitService();

		$this->assertSame( 1.0, $service->points_multiplier_for_user( $user_id ) );
		$this->assertSame( 0.0, $service->discount_percentage_for_user( $user_id ) );
	}

	public function test_a_tiers_bonus_multiplier_applies_once_a_customer_qualifies_for_that_tier(): void {
		$tier_service = new TierService();
		$tier         = $tier_service->create( 'gold', 'طلایی', 500 );
		( new BenefitService() )->create( BenefitService::SOURCE_TIER, $tier['id'], BenefitService::TYPE_BONUS_POINTS_MULTIPLIER, 'امتیاز مضاعف', [ 'multiplier' => 2.0 ] );

		$user_id = self::factory()->user->create();
		$benefit = new BenefitService();
		$this->assertSame( 1.0, $benefit->points_multiplier_for_user( $user_id ), 'Below the tier threshold, the multiplier must stay at the 1.0 default.' );

		( new LoyaltyLedger() )->award( $user_id, 500, 'booking_completed' );
		$this->assertSame( 2.0, $benefit->points_multiplier_for_user( $user_id ) );
	}

	public function test_a_membership_plans_discount_applies_only_while_the_membership_is_active(): void {
		$plan_service = new MembershipService();
		$plan         = $plan_service->create_plan( 'plus', 'پلاس', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف رزرو', [ 'percentage' => 10 ] );

		$user_id = self::factory()->user->create();
		$benefit = new BenefitService();
		$this->assertSame( 0.0, $benefit->discount_percentage_for_user( $user_id ) );

		$plan_service->activate( $user_id, $plan['id'], 'manual' );
		$this->assertSame( 10.0, $benefit->discount_percentage_for_user( $user_id ) );

		$plan_service->cancel( $user_id );
		$this->assertSame( 0.0, $benefit->discount_percentage_for_user( $user_id ), 'A cancelled membership must no longer grant its discount benefit.' );
	}

	public function test_an_inactive_benefit_is_never_applied(): void {
		$plan_service = new MembershipService();
		$plan         = $plan_service->create_plan( 'plus', 'پلاس', null, false, null, null );
		$benefit      = new BenefitService();
		$created      = $benefit->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف رزرو', [ 'percentage' => 10 ] );
		$benefit->update( $created['id'], [ 'isActive' => false ] );

		$user_id = self::factory()->user->create();
		$plan_service->activate( $user_id, $plan['id'], 'manual' );

		$this->assertSame( 0.0, $benefit->discount_percentage_for_user( $user_id ) );
	}

	public function test_discount_percentage_is_capped_at_100(): void {
		$plan_service = new MembershipService();
		$plan         = $plan_service->create_plan( 'plus', 'پلاس', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف عجیب', [ 'percentage' => 250 ] );

		$user_id = self::factory()->user->create();
		$plan_service->activate( $user_id, $plan['id'], 'manual' );

		$this->assertSame( 100.0, ( new BenefitService() )->discount_percentage_for_user( $user_id ) );
	}

	public function test_creating_a_benefit_with_an_invalid_type_is_rejected(): void {
		$result = ( new BenefitService() )->create( BenefitService::SOURCE_TIER, 1, 'not_a_real_type', 'برچسب', [] );
		$this->assertIsString( $result );
	}

	public function test_a_descriptive_benefit_never_affects_multiplier_or_discount(): void {
		$tier_service = new TierService();
		$tier         = $tier_service->create( 'gold', 'طلایی', 0 );
		( new BenefitService() )->create( BenefitService::SOURCE_TIER, $tier['id'], BenefitService::TYPE_DESCRIPTIVE, 'دسترسی زودتر به تخفیف‌های ویژه', [] );

		$user_id = self::factory()->user->create();
		$benefit = new BenefitService();

		$this->assertSame( 1.0, $benefit->points_multiplier_for_user( $user_id ) );
		$this->assertSame( 0.0, $benefit->discount_percentage_for_user( $user_id ) );
		$this->assertCount( 1, $benefit->benefits_for_user( $user_id ), 'The descriptive benefit must still be visible to the customer, even though it has no functional effect.' );
	}
}
