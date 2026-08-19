<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Tests;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Pricing\TierPricingEngine;
use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Booking\RescheduleService;
use BeauClick\Campaigns\CampaignService;
use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

/**
 * End-to-end paths through the real cross-plugin hook seam
 * (`beauclick/booking/after_create`, fired by `BookingController::create()`),
 * mirroring beauclick-loyalty's own `LoyaltyIntegrationTest` — the real risk
 * a Campaign discount introduces is whether it behaves correctly *together*
 * with everything already hooked onto the same order, not whether
 * `EligibilityResolver` works in isolation (covered by its own test).
 *
 * Deliberately never calls `(new CampaignDiscount())->register()` (or any
 * other beauclick-campaigns registrar) itself — the real plugin bootstrap
 * already registers every hook exactly once for the whole test run. Doing so
 * here would add a second, independent callback instance, silently
 * double-applying the discount (the exact bug LoyaltyIntegrationTest's own
 * docblock already warns about).
 */
final class CampaignDiscountIntegrationTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id, string $start = '2027-09-01 10:00:00', string $end = '2027-09-01 11:00:00' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => $start, 'end_at' => $end, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function make_priced_service( int $provider_post_id, int $price ): int {
		return self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_post_id, 'meta_input' => [ '_bc_price' => $price, '_bc_duration_minutes' => 60 ] ]
		);
	}

	private function make_provider(): int {
		$owner = self::factory()->user->create();
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner ] );
	}

	private function create_active_campaign( array $overrides = [] ): array {
		$service = new CampaignService();
		$id      = $service->create(
			array_merge(
				[ 'name' => 'کمپین تست', 'discountType' => CampaignService::TYPE_PERCENTAGE, 'discountValue' => 15 ],
				$overrides
			)
		)['id'];
		$service->activate( $id );
		return $service->find( $id );
	}

	// 1. A real fee is added to a real booking order, and displayed == charged.
	public function test_a_campaign_discount_is_applied_as_a_real_order_fee_with_displayed_equal_to_charged_price(): void {
		$this->create_active_campaign( [ 'discountValue' => 15 ] );

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 1000000 );
		$customer_id   = self::factory()->user->create();

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 11 ],
			[ 'booking_id' => 11, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$this->assertArrayHasKey( 'orderId', $result );
		$order = wc_get_order( $result['orderId'] );

		$this->assertEqualsWithDelta( 850000.0, (float) $order->get_total(), 0.01 );

		$fees = $order->get_items( 'fee' );
		$this->assertCount( 1, $fees );
		$fee = array_values( $fees )[0];
		$this->assertStringContainsString( 'کمپین تست', $fee->get_name() );
		$this->assertEqualsWithDelta( -150000.0, (float) $fee->get_total(), 0.01 );

		$reloaded = wc_get_order( $result['orderId'] );
		$this->assertSame( $order->get_total(), $reloaded->get_total(), 'Displayed and charged amounts must be the exact same number on reload.' );
	}

	// 2. No campaign, no fee -- the common case is unaffected.
	public function test_no_fee_is_added_with_no_active_campaign(): void {
		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 500000 );
		$customer_id   = self::factory()->user->create();

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 12 ],
			[ 'booking_id' => 12, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$order = wc_get_order( $result['orderId'] );
		$this->assertEqualsWithDelta( 500000.0, (float) $order->get_total(), 0.01 );
		$this->assertCount( 0, $order->get_items( 'fee' ) );
	}

	/**
	 * Idempotency: the SAME booking_id must never be granted a campaign
	 * discount twice, ever, regardless of how many times the filter chain is
	 * re-fired for it. Since GAP-03 (V2.4 Step 26 part 2), `beauclick-payments
	 * \Booking\BookingOrderBridge::create_order_for_booking()` itself now
	 * returns the SAME order for a booking_id that already has one, rather
	 * than the old behavior of creating a second, orphaned order every fire
	 * — so a re-fire lands on the identical order, and this plugin's own
	 * `UNIQUE(booking_id)` usage constraint is exercised as the second,
	 * defense-in-depth layer: re-running `CampaignDiscount::apply()` against
	 * that same order for that same booking must never add a second fee.
	 */
	public function test_the_same_booking_id_is_never_granted_the_discount_twice_across_any_number_of_orders(): void {
		$campaign_row = $this->create_active_campaign();

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 400000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post );

		// GAP-03's fix keys off a REAL `wp_bc_bookings.wc_order_id` value, so
		// this must be a real booking (not a hand-built filter context with a
		// synthetic booking_id) for the re-fire to actually exercise it.
		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$context = [ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ];

		$first = apply_filters( 'beauclick/booking/after_create', $booking, $context );
		$this->assertCount( 1, wc_get_order( $first['orderId'] )->get_items( 'fee' ), 'The first, real order for this booking must receive the discount.' );

		$second = apply_filters( 'beauclick/booking/after_create', $booking, $context );
		$this->assertSame( $first['orderId'], $second['orderId'], 'Since GAP-03, a second fire for the same booking_id must return the SAME order, never a duplicate.' );
		$this->assertCount( 1, wc_get_order( $second['orderId'] )->get_items( 'fee' ), 'The same order must still show exactly one fee -- not removed, not duplicated.' );

		$this->assertSame( 1, ( new CampaignService() )->usage_count( $campaign_row['id'] ), 'Exactly one usage row must ever exist for this booking, no matter how many times the filter fired.' );
	}

	// 4. Stacking with Membership: both discounts apply, computed independently against the same subtotal (no compounding), and the order total reflects both.
	public function test_membership_and_campaign_discounts_stack_without_compounding(): void {
		$plan = ( new MembershipService() )->create_plan( 'plus', 'پلاس', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف عضویت', [ 'percentage' => 10 ] );
		$this->create_active_campaign( [ 'discountValue' => 15 ] );

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 1000000 );
		$customer_id   = self::factory()->user->create();
		( new MembershipService() )->activate( $customer_id, $plan['id'], 'manual' );

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 14 ],
			[ 'booking_id' => 14, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$order = wc_get_order( $result['orderId'] );
		$fees  = array_values( $order->get_items( 'fee' ) );
		$this->assertCount( 2, $fees, 'Both the membership fee and the campaign fee must appear as separate, itemized lines.' );

		// 10% membership + 15% campaign, EACH independently against the
		// 1,000,000 subtotal (100,000 + 150,000 = 250,000 total discount) --
		// NOT 15% compounded on top of an already-discounted 900,000.
		$this->assertEqualsWithDelta( 750000.0, (float) $order->get_total(), 0.01 );
	}

	// 5. The never-negative clamp: an aggressive campaign discount combined with an existing membership discount must never push the order below zero.
	public function test_the_combined_discount_never_pushes_the_order_total_negative(): void {
		$plan = ( new MembershipService() )->create_plan( 'plus2', 'پلاس دو', null, false, null, null );
		( new BenefitService() )->create( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], BenefitService::TYPE_DISCOUNT_PERCENTAGE, 'تخفیف عضویت', [ 'percentage' => 60 ] );
		$this->create_active_campaign( [ 'discountValue' => 60 ] );

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 100000 );
		$customer_id   = self::factory()->user->create();
		( new MembershipService() )->activate( $customer_id, $plan['id'], 'manual' );

		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 15 ],
			[ 'booking_id' => 15, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);

		$order = wc_get_order( $result['orderId'] );
		$this->assertGreaterThanOrEqual( 0.0, (float) $order->get_total(), 'A 60% + 60% combined discount must clamp at zero, never go negative.' );
	}

	// 6. Structural safety: beauclick-campaigns must never hook a WooCommerce cart/product-price filter -- only an order-level fee.
	public function test_campaigns_registers_no_woocommerce_cart_or_product_price_hook(): void {
		global $wp_filter;
		foreach ( [ 'woocommerce_before_calculate_totals', 'woocommerce_product_get_price', 'woocommerce_get_price', 'woocommerce_cart_item_price', 'woocommerce_add_to_cart_validation' ] as $hook ) {
			if ( empty( $wp_filter[ $hook ] ) ) {
				continue;
			}
			foreach ( $wp_filter[ $hook ]->callbacks as $callbacks ) {
				foreach ( $callbacks as $cb ) {
					$function = $cb['function'];
					$class    = is_array( $function ) ? get_class( $function[0] ) : ( is_string( $function ) ? $function : '' );
					$this->assertStringNotContainsString( 'BeauClick\\Campaigns', $class, "beauclick-campaigns must never hook {$hook} -- that's B2B's TierPricingEngine's own cart filter; campaign pricing goes through a booking-order fee instead." );
				}
			}
		}
	}

	// 7. B2B pricing is completely unaffected by an active campaign -- Phase 1 never touches B2B/cart orders at all.
	public function test_b2b_tier_pricing_is_unaffected_by_an_active_campaign(): void {
		$this->create_active_campaign( [ 'discountValue' => 90 ] ); // Deliberately aggressive -- proves it truly cannot reach B2B pricing.

		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Wholesale Product' );
		$product->set_regular_price( '100000' );
		$product->set_price( '100000' );
		$product->save();

		( new TierPricingEngine() )->set_tiers(
			$product->get_id(),
			[ [ 'min_qty' => 1, 'max_qty' => 9, 'price' => 100000 ], [ 'min_qty' => 10, 'max_qty' => null, 'price' => 90000 ] ]
		);

		$business_user = self::factory()->user->create();
		( new BusinessAccountService() )->approve( ( new BusinessAccountService() )->apply( $business_user, 'Test Salon' ) );

		$engine = new TierPricingEngine();
		$this->assertSame( 90000, $engine->price_for_quantity( $product->get_id(), 10 ) );
	}

	// 8. Usage release on cancellation: a cancelled order's usage no longer counts against a per-customer cap, letting the same customer use the campaign again.
	public function test_cancelling_an_order_releases_the_campaign_usage_for_a_per_customer_limit(): void {
		$campaign_row = $this->create_active_campaign( [ 'usageLimitPerCustomer' => 1 ] );

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 200000 );
		$customer_id   = self::factory()->user->create();

		$first = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 16 ],
			[ 'booking_id' => 16, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$this->assertCount( 1, wc_get_order( $first['orderId'] )->get_items( 'fee' ) );

		// A second booking for the SAME customer, before the first order dies, must NOT get the discount again (per-customer cap of 1).
		$second = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 17 ],
			[ 'booking_id' => 17, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$this->assertCount( 0, wc_get_order( $second['orderId'] )->get_items( 'fee' ), 'The per-customer usage cap must block a second discounted booking while the first is still live.' );

		// Cancel the first order -- releases the usage slot.
		wc_get_order( $first['orderId'] )->update_status( 'cancelled' );
		$this->assertSame( 0, ( new CampaignService() )->usage_count( $campaign_row['id'], $customer_id ) );

		// A third booking for the same customer must now get the discount again.
		$third = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 18 ],
			[ 'booking_id' => 18, 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$this->assertCount( 1, wc_get_order( $third['orderId'] )->get_items( 'fee' ), 'Releasing the first order\'s usage must free the per-customer slot for a new booking.' );
	}

	// 9. Rescheduling a discounted booking never touches the order, the fee, or the usage row -- confirms RescheduleService's own "never touches the order" claim holds true with a campaign fee present.
	public function test_rescheduling_a_discounted_booking_leaves_the_fee_and_usage_untouched(): void {
		$campaign_row = $this->create_active_campaign();

		$provider_post = $this->make_provider();
		$service_id    = $this->make_priced_service( $provider_post, 300000 );
		$customer_id   = self::factory()->user->create();
		$slot_id       = $this->make_open_slot( $provider_post );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_post, $slot_id, $service_id );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = apply_filters(
			'beauclick/booking/after_create',
			$booking,
			[ 'booking_id' => $booking['booking_id'], 'customer_id' => $customer_id, 'provider_id' => $provider_post, 'service_id' => $service_id ]
		);
		$order_id      = $result['orderId'];
		$total_before  = (float) wc_get_order( $order_id )->get_total();

		$new_slot_id = $this->make_open_slot( $provider_post, '2027-09-02 10:00:00', '2027-09-02 11:00:00' );
		$reschedule  = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot_id, $customer_id );
		$this->assertIsArray( $reschedule, 'Reschedule must succeed for this deterministic, far-future, first-time scenario.' );

		$order = wc_get_order( $order_id );
		$this->assertCount( 1, $order->get_items( 'fee' ), 'The campaign fee must survive a reschedule unchanged.' );
		$this->assertEqualsWithDelta( $total_before, (float) $order->get_total(), 0.01 );
		$this->assertSame( 1, ( new CampaignService() )->usage_count( $campaign_row['id'], $customer_id ), 'The usage row must remain live after a reschedule -- it is not a new booking.' );
	}
}
