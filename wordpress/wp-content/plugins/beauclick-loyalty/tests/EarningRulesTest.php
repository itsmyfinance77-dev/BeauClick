<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Loyalty\EarningRules;
use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Payments\Booking\BookingOrderBridge;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_UnitTestCase;

/**
 * V2.0 Step 1 — activates the previously-dormant LoyaltyLedger via the
 * hook seams EarningRules subscribes to. These tests exercise the real
 * cross-plugin path (a genuine BookingService/ReviewService/WC_Order
 * operation firing the hook), not EarningRules' methods called directly,
 * since the actual risk this task cares about is duplicate AWARDS from
 * real, repeated domain operations.
 */
final class EarningRulesTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => '2026-09-01 10:00:00', 'end_at' => '2026-09-01 11:00:00', 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function make_completed_booking( int $customer_id, int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 1,
				'slot_start'  => '2026-09-01 10:00:00',
				'slot_end'    => '2026-09-01 11:00:00',
				'status'      => 'completed',
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	public function test_completing_a_booking_awards_points_once(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );

		$this->assertSame( EarningRules::POINTS_BOOKING_COMPLETED, ( new LoyaltyLedger() )->balance( $customer_id ) );
	}

	public function test_repeated_completion_processing_does_not_award_points_twice(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_id, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] ); // Already completed -- the status-transition guard alone should block re-firing the hook.

		$this->assertSame(
			EarningRules::POINTS_BOOKING_COMPLETED,
			( new LoyaltyLedger() )->balance( $customer_id ),
			'A second complete_booking() call on an already-completed booking must not award points again.'
		);
	}

	public function test_submitting_a_review_awards_points_once(): void {
		$provider_owner = self::factory()->user->create();
		$provider_id    = \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL;
		$provider_post  = self::factory()->post->create( [ 'post_type' => $provider_id, 'post_status' => 'publish', 'post_author' => $provider_owner ] );
		$customer_id    = self::factory()->user->create();
		$booking_id     = $this->make_completed_booking( $customer_id, $provider_post );

		( new ReviewService() )->create( $customer_id, $booking_id, 5, 'عالی' );

		$this->assertSame( EarningRules::POINTS_REVIEW_SUBMITTED, ( new LoyaltyLedger() )->balance( $customer_id ) );
	}

	public function test_repeated_review_processing_does_not_award_points_twice(): void {
		$provider_owner = self::factory()->user->create();
		$provider_post  = self::factory()->post->create( [ 'post_type' => \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $provider_owner ] );
		$customer_id    = self::factory()->user->create();
		$booking_id     = $this->make_completed_booking( $customer_id, $provider_post );

		$service = new ReviewService();
		$service->create( $customer_id, $booking_id, 5, 'عالی' );
		$second = $service->create( $customer_id, $booking_id, 1, 'دوباره' ); // Already-reviewed booking -- rejected before any insert.

		$this->assertIsString( $second, 'A second review against the same booking must be rejected.' );
		$this->assertSame(
			EarningRules::POINTS_REVIEW_SUBMITTED,
			( new LoyaltyLedger() )->balance( $customer_id ),
			'A rejected second review must not award points again.'
		);
	}

	public function test_completing_payment_for_a_real_shop_order_awards_points_once(): void {
		$customer_id = self::factory()->user->create();

		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'pending' );
		$order->save();

		$order->payment_complete();

		$this->assertSame( EarningRules::POINTS_SHOP_ORDER_COMPLETED, ( new LoyaltyLedger() )->balance( $customer_id ) );
	}

	public function test_a_bookings_own_linked_order_does_not_separately_award_shop_order_points(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $slot_id );

		$product = new \WC_Product_Simple();
		$product->set_name( 'میکاپ عروس' );
		$product->set_regular_price( '2500000' );
		$product->set_price( '2500000' );
		$product->set_virtual( true );
		$product->save();

		$order = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );
		$order->payment_complete(); // Confirms the booking -- must NOT also fire shop_order_completed.

		$this->assertSame(
			0,
			( new LoyaltyLedger() )->balance( $customer_id ),
			"A booking's own linked order paying must not award shop_order_completed points -- that would double-count the same real transaction once complete_booking() later awards booking_completed points."
		);
	}

	public function test_repeated_payment_complete_processing_does_not_award_shop_order_points_twice(): void {
		$customer_id = self::factory()->user->create();

		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'pending' );
		$order->save();

		$order->payment_complete();
		$order->payment_complete(); // Simulates a duplicated webhook/gateway retry re-firing woocommerce_payment_complete.

		$this->assertSame(
			EarningRules::POINTS_SHOP_ORDER_COMPLETED,
			( new LoyaltyLedger() )->balance( $customer_id ),
			'A re-fired payment_complete for the same order must not award points a second time.'
		);
	}

	public function test_a_guest_checkout_order_is_not_awarded_points(): void {
		$order = new \WC_Order();
		$order->set_status( 'pending' );
		$order->save(); // No customer_id set -- guest checkout.

		$order->payment_complete();

		// No assertion possible on "customer 0" -- this just asserts nothing
		// fatals and no stray ledger row with user_id = 0 is created.
		global $wpdb;
		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_loyalty_points WHERE user_id = 0" );
		$this->assertSame( 0, $count, 'A guest checkout order must never create a loyalty row for user_id 0.' );
	}

	/**
	 * Every award() call in EarningRules is server-triggered from a trusted
	 * domain operation (a real completed booking, a real inserted review, a
	 * real paid WooCommerce order) -- there is no REST parameter anywhere
	 * that lets a caller name an arbitrary user_id/points/reason. This
	 * asserts the concrete case: crediting customer A's booking completion
	 * must never touch customer B's balance.
	 */
	public function test_a_customers_earned_points_never_affect_another_customers_balance(): void {
		$provider_id = self::factory()->user->create();
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service = new BookingService();
		$booking = $service->create_booking( $customer_a, $provider_id, $slot_id );
		$service->confirm_booking( $booking['booking_id'] );
		$service->complete_booking( $booking['booking_id'] );

		$ledger = new LoyaltyLedger();
		$this->assertSame( EarningRules::POINTS_BOOKING_COMPLETED, $ledger->balance( $customer_a ) );
		$this->assertSame( 0, $ledger->balance( $customer_b ), "Customer B's balance must be untouched by customer A's booking completion." );
	}
}
