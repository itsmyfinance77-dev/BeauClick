<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Pricing\TierPricingEngine;
use BeauClick\Booking\Booking\BookingService;
use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Loyalty\Membership\TierMembershipSync;
use BeauClick\Loyalty\Tiers\TierService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * End-to-end paths through real cross-plugin hook seams, not the isolated
 * service classes -- the actual risk this step's WooCommerce price-hook
 * concern (task §10) cares about is whether these real integrations behave
 * correctly and safely together, not whether each class works in
 * isolation (already covered by TierServiceTest/MembershipServiceTest/
 * BenefitServiceTest).
 *
 * Deliberately never calls `(new MembershipDiscount())->register()` (or any
 * other beauclick-loyalty registrar) itself -- the real plugin bootstrap
 * already registers every hook exactly once for the whole test run (same
 * convention EarningRulesTest already relies on). Re-registering here would
 * add a SECOND, independent callback instance on the same filter (WordPress
 * treats two different object instances as two different callbacks even
 * for the same method), silently double-applying the discount -- a real
 * bug this file's own first draft hit and fixed before being trusted.
 */
final class LoyaltyIntegrationTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => '2026-09-01 10:00:00', 'end_at' => '2026-09-01 11:00:00', 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function make_priced_service( int $provider_post_id, int $price ): int {
		return self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_post_id, 'meta_input' => [ '_bc_price' => $price, '_bc_duration_minutes' => 60 ] ]
		);
	}

	// A real booking completion, with a tier bonus-points-multiplier benefit active.
	public function test_a_tier_bonus_multiplier_actually_increases_points_from_a_real_booking_completion(): void {
		$tier = ( new TierService() )->create( 'vip', 'ویژه', 0 ); // threshold 0 -- every customer qualifies immediately.
		( new BenefitService() )->create( BenefitService::SOURCE_TIER, $tier['id'], BenefitService::TYPE_BONUS_POINTS_MULTIPLIER, 'دو برابر امتیاز', [ 'multiplier' => 2.0 ] );

		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );

		$this->assertSame( 20, ( new LoyaltyLedger() )->balance( $customer_id ), 'A x2 multiplier tier benefit must double the real 10-point booking-completion award to 20.' );
	}

	// Existing earning behavior stays exactly as before when no benefit applies -- direct re-confirmation alongside the pre-existing EarningRulesTest suite.
	public function test_booking_completion_awards_the_unmultiplied_amount_when_no_benefit_applies(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );

		$this->assertSame( 10, ( new LoyaltyLedger() )->balance( $customer_id ) );
	}

	// Qualifying for a tier-linked plan auto-activates the matching membership from a real award.
	public function test_qualifying_for_a_tier_linked_plan_auto_activates_membership_from_a_real_award(): void {
		$tier = ( new TierService() )->create( 'gold', 'طلایی', 10 );
		$plan = ( new MembershipService() )->create_plan( 'gold-membership', 'عضویت طلایی', $tier['id'], false, null, null );

		$user_id = self::factory()->user->create();
		$this->assertNull( ( new MembershipService() )->for_user( $user_id ) );

		( new LoyaltyLedger() )->award( $user_id, 10, 'booking_completed' );
		do_action( 'beauclick/loyalty/points_awarded', $user_id ); // Direct award() bypasses EarningRules -- fire the same hook a real award_once() call would.

		$membership = ( new MembershipService() )->for_user( $user_id );
		$this->assertNotNull( $membership );
		$this->assertSame( $plan['id'], $membership['planId'] );
		$this->assertSame( 'tier_qualification', $membership['activationSource'] );
	}

	public function test_tier_qualification_sync_never_overwrites_a_manually_granted_membership(): void {
		$tier        = ( new TierService() )->create( 'gold', 'طلایی', 10 );
		$tier_plan   = ( new MembershipService() )->create_plan( 'gold-membership', 'عضویت طلایی', $tier['id'], false, null, null );
		$manual_plan = ( new MembershipService() )->create_plan( 'special', 'عضویت ویژه دستی', null, false, null, null );

		$user_id = self::factory()->user->create();
		( new MembershipService() )->activate( $user_id, $manual_plan['id'], 'manual' );

		( new LoyaltyLedger() )->award( $user_id, 10, 'booking_completed' );
		( new TierMembershipSync() )->sync( $user_id );

		$membership = ( new MembershipService() )->for_user( $user_id );
		$this->assertSame( $manual_plan['id'], $membership['planId'], "Tier qualification must never silently overwrite a membership an admin manually granted." );
	}

	// The real, itemized order-fee discount mechanism -- via the exact filter the REST booking-create endpoint fires (BookingController::create()).
	public function test_a_membership_discount_is_applied_as_a_real_order_fee_with_displayed_equal_to_charged_price(): void {
		$plan = ( new MembershipService() )->create_plan( 'plus', 'پلاس', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف رزرو', [ 'percentage' => 10 ] );

		$provider_owner = self::factory()->user->create();
		$provider_post  = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $provider_owner ] );
		$service_id     = $this->make_priced_service( $provider_post, 1000000 );

		$customer_id = self::factory()->user->create();
		( new MembershipService() )->activate( $customer_id, $plan['id'], 'manual' );

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 1 ],
			[ 'booking_id' => 1, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$this->assertArrayHasKey( 'orderId', $result );
		$order = wc_get_order( $result['orderId'] );

		$this->assertEqualsWithDelta( 900000.0, (float) $order->get_total(), 0.01, 'A 10% membership discount on a 1,000,000 Toman service must charge exactly 900,000.' );

		$fees = $order->get_items( 'fee' );
		$this->assertCount( 1, $fees, 'The discount must appear as its own itemized, customer-visible line -- never a silently modified product price.' );
		$fee = array_values( $fees )[0];
		$this->assertEqualsWithDelta( -100000.0, (float) $fee->get_total(), 0.01 );

		// "Displayed = charged": WooCommerce's own pay-for-order page always
		// renders get_total() -- reloading the same order object must
		// return the exact figure that was actually charged, not a second,
		// independently-derived number.
		$reloaded = wc_get_order( $result['orderId'] );
		$this->assertSame( $order->get_total(), $reloaded->get_total() );
	}

	public function test_no_discount_fee_is_added_when_the_customer_has_no_active_membership_benefit(): void {
		$provider_owner = self::factory()->user->create();
		$provider_post  = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $provider_owner ] );
		$service_id     = $this->make_priced_service( $provider_post, 500000 );
		$customer_id    = self::factory()->user->create();

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 2 ],
			[ 'booking_id' => 2, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$order = wc_get_order( $result['orderId'] );
		$this->assertEqualsWithDelta( 500000.0, (float) $order->get_total(), 0.01 );
		$this->assertCount( 0, $order->get_items( 'fee' ) );
	}

	// The structural safety claim behind this step's WooCommerce price-hook
	// risk analysis: loyalty/membership pricing never touches the cart or
	// any product-price filter at all -- it can't stack with B2B's
	// TierPricingEngine (a cart hook) because it isn't one.
	public function test_loyalty_registers_no_woocommerce_cart_or_product_price_hook(): void {
		global $wp_filter;
		foreach ( [ 'woocommerce_before_calculate_totals', 'woocommerce_product_get_price', 'woocommerce_get_price', 'woocommerce_cart_item_price', 'woocommerce_add_to_cart_validation' ] as $hook ) {
			if ( empty( $wp_filter[ $hook ] ) ) {
				continue;
			}
			foreach ( $wp_filter[ $hook ]->callbacks as $callbacks ) {
				foreach ( $callbacks as $cb ) {
					$function = $cb['function'];
					$class    = is_array( $function ) ? get_class( $function[0] ) : ( is_string( $function ) ? $function : '' );
					$this->assertStringNotContainsString( 'BeauClick\\Loyalty', $class, "beauclick-loyalty must never hook {$hook} -- that hook belongs to B2B's TierPricingEngine (a WooCommerce CART filter); loyalty pricing goes through a booking-order fee instead." );
				}
			}
		}
	}

	// 16. B2B pricing remains correct -- unaffected by anything loyalty adds.
	public function test_b2b_tier_pricing_is_unaffected_by_loyalty_being_active(): void {
		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Wholesale Product' );
		$product->set_regular_price( '100000' );
		$product->set_price( '100000' );
		$product->save();

		( new TierPricingEngine() )->set_tiers(
			$product->get_id(),
			[ [ 'min_qty' => 1, 'max_qty' => 9, 'price' => 100000 ], [ 'min_qty' => 10, 'max_qty' => null, 'price' => 90000 ] ]
		);

		// Give the B2B buyer a real, active loyalty membership discount too
		// -- proving B2B's own quantity-tier price is what wins on a
		// wholesale product regardless, since loyalty structurally never
		// touches product/cart pricing at all.
		$business_user = self::factory()->user->create();
		( new BusinessAccountService() )->approve( ( new BusinessAccountService() )->apply( $business_user, 'Test Salon' ) );
		$plan = ( new MembershipService() )->create_plan( 'plus2', 'پلاس دو', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف', [ 'percentage' => 50 ] );
		( new MembershipService() )->activate( $business_user, $plan['id'], 'manual' );

		$engine = new TierPricingEngine();
		$this->assertSame( 90000, $engine->price_for_quantity( $product->get_id(), 10 ), 'B2B quantity-tier pricing must be exactly what it was before loyalty existed -- 90,000 for 10 units, unaffected by the buyer also holding an active loyalty discount benefit.' );
	}
}
