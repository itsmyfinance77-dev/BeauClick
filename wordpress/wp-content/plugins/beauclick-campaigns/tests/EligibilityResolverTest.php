<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Tests;

use BeauClick\Campaigns\CampaignService;
use BeauClick\Campaigns\EligibilityResolver;
use WP_UnitTestCase;

final class EligibilityResolverTest extends WP_UnitTestCase {

	private CampaignService $campaigns;
	private EligibilityResolver $resolver;

	public function set_up(): void {
		parent::set_up();
		$this->campaigns = new CampaignService();
		$this->resolver  = new EligibilityResolver( $this->campaigns );
	}

	private function active_campaign( array $overrides = [] ): array {
		$fields = array_merge(
			[
				'name'          => 'کمپین',
				'discountType'  => CampaignService::TYPE_PERCENTAGE,
				'discountValue' => 10,
			],
			$overrides
		);
		$id = $this->campaigns->create( $fields )['id'];
		$this->campaigns->activate( $id );
		return $this->campaigns->find( $id );
	}

	private function context( array $overrides = [] ): array {
		return array_merge(
			[ 'serviceId' => null, 'providerId' => 1, 'customerId' => 1, 'subtotal' => 1000000, 'bookingId' => 1 ],
			$overrides
		);
	}

	private function insert_booking( int $customer_id, string $status ): void {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => 1,
				'slot_id'     => 1,
				'slot_start'  => '2026-01-01 10:00:00',
				'slot_end'    => '2026-01-01 11:00:00',
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
	}

	// 1. No active campaigns -> null.
	public function test_returns_null_with_no_campaigns(): void {
		$this->assertNull( $this->resolver->best_campaign_for( $this->context() ) );
	}

	// 2. A simple percentage campaign applies and computes the correct amount.
	public function test_a_percentage_campaign_computes_the_correct_discount(): void {
		$this->active_campaign( [ 'discountValue' => 10 ] );

		$best = $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 1000000 ] ) );

		$this->assertNotNull( $best );
		$this->assertSame( 100000, $best['discountAmount'] );
	}

	// 3. A fixed discount is capped at the subtotal -- never produces a negative order total on its own.
	public function test_a_fixed_discount_never_exceeds_the_subtotal(): void {
		$this->active_campaign( [ 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 50000 ] );

		$best = $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 30000 ] ) );

		$this->assertSame( 30000, $best['discountAmount'] );
	}

	// 4. maxDiscountAmount caps a percentage discount.
	public function test_max_discount_amount_caps_a_percentage_discount(): void {
		$this->active_campaign( [ 'discountValue' => 50, 'maxDiscountAmount' => 20000 ] );

		$best = $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 1000000 ] ) );

		$this->assertSame( 20000, $best['discountAmount'], '50% of 1,000,000 is 500,000, but the campaign caps at 20,000.' );
	}

	// 5. minOrderValue excludes an order below the threshold.
	public function test_min_order_value_excludes_a_smaller_order(): void {
		$this->active_campaign( [ 'minOrderValue' => 500000 ] );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 400000 ] ) ) );
		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 500000 ] ) ) );
	}

	// 6. serviceId/providerId targeting excludes a non-matching booking.
	public function test_service_and_provider_targeting_excludes_non_matching_bookings(): void {
		$this->active_campaign( [ 'serviceId' => 42 ] );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'serviceId' => 43 ] ) ) );
		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'serviceId' => 42 ] ) ) );
	}

	// 7. first_booking scope: eligible only for a customer with no prior confirmed/completed booking.
	public function test_first_booking_scope_excludes_a_customer_with_confirmed_history(): void {
		$this->active_campaign( [ 'customerScope' => CampaignService::SCOPE_FIRST_BOOKING ] );

		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 1 ] ) ), 'A customer with no booking history at all must qualify as first-time.' );

		$this->insert_booking( 2, 'confirmed' );
		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 2 ] ) ) );
	}

	// 8. A merely cancelled/pending prior booking does not disqualify a "first booking" campaign.
	public function test_first_booking_scope_ignores_cancelled_and_pending_history(): void {
		$this->active_campaign( [ 'customerScope' => CampaignService::SCOPE_FIRST_BOOKING ] );

		$this->insert_booking( 3, 'cancelled' );
		$this->insert_booking( 3, 'pending' );

		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 3 ] ) ) );
	}

	// 9. returning scope: the exact opposite of first_booking.
	public function test_returning_scope_requires_confirmed_or_completed_history(): void {
		$this->active_campaign( [ 'customerScope' => CampaignService::SCOPE_RETURNING ] );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 4 ] ) ) );

		$this->insert_booking( 4, 'completed' );
		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 4 ] ) ) );
	}

	// 10. usageLimitTotal excludes once the cap is reached.
	public function test_usage_limit_total_excludes_once_reached(): void {
		$campaign = $this->active_campaign( [ 'usageLimitTotal' => 1 ] );
		$this->campaigns->record_usage( $campaign['id'], 900, 900, 55, 1000 );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context() ) );
	}

	// 11. usageLimitPerCustomer excludes only the customer who already used it -- another customer is unaffected.
	public function test_usage_limit_per_customer_only_excludes_that_customer(): void {
		$campaign = $this->active_campaign( [ 'usageLimitPerCustomer' => 1 ] );
		$this->campaigns->record_usage( $campaign['id'], 901, 901, 55, 1000 );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 55 ] ) ) );
		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context( [ 'customerId' => 56 ] ) ) );
	}

	// 12. A released usage does not count against usageLimitTotal.
	public function test_a_released_usage_no_longer_counts_against_the_total_limit(): void {
		$campaign = $this->active_campaign( [ 'usageLimitTotal' => 1 ] );
		$this->campaigns->record_usage( $campaign['id'], 902, 902, 55, 1000 );
		$this->campaigns->release_usage_for_order( 902 );

		$this->assertNotNull( $this->resolver->best_campaign_for( $this->context() ) );
	}

	// 13. Stacking: when two campaigns are eligible, the one with the larger discount for this order wins.
	public function test_the_larger_discount_wins_when_multiple_campaigns_are_eligible(): void {
		$this->active_campaign( [ 'name' => 'کوچک', 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 10000 ] );
		$bigger = $this->active_campaign( [ 'name' => 'بزرگ', 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 50000 ] );

		$best = $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 1000000 ] ) );

		$this->assertSame( $bigger['id'], $best['campaign']['id'] );
		$this->assertSame( 50000, $best['discountAmount'] );
	}

	// 14. Tie-break: equal discount amounts -> the oldest (lowest id) campaign wins.
	public function test_equal_discounts_are_broken_by_the_oldest_campaign(): void {
		$first  = $this->active_campaign( [ 'name' => 'اول', 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 20000 ] );
		$this->active_campaign( [ 'name' => 'دوم', 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 20000 ] );

		$best = $this->resolver->best_campaign_for( $this->context() );

		$this->assertSame( $first['id'], $best['campaign']['id'] );
	}

	// 15. A zero-value computed discount (e.g. subtotal 0) is never returned as a "best" match.
	public function test_a_zero_discount_result_is_treated_as_ineligible(): void {
		$this->active_campaign( [ 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 1000 ] );

		$this->assertNull( $this->resolver->best_campaign_for( $this->context( [ 'subtotal' => 0 ] ) ) );
	}
}
