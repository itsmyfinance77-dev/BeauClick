<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Payments\Booking\BookingOrderBridge;
use WP_UnitTestCase;

final class BookingOrderBridgeTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => '2026-09-01 10:00:00', 'end_at' => '2026-09-01 11:00:00', 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	private function make_product( string $name, int $price ): \WC_Product {
		$product = new \WC_Product_Simple();
		$product->set_name( $name );
		$product->set_regular_price( (string) $price );
		$product->set_price( (string) $price );
		$product->set_virtual( true );
		$product->save();
		return $product;
	}

	public function test_creating_an_order_links_it_to_the_booking(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot_id );
		$product = $this->make_product( 'میکاپ عروس', 2500000 );
		$order   = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );

		$this->assertSame( 'pending', $order->get_status() );
		$this->assertSame( 2500000.0, (float) $order->get_total() );

		$items = $order->get_items();
		$item  = reset( $items );
		$this->assertInstanceOf( \WC_Order_Item_Product::class, $item, 'The line item must be a real product line, not a fee — needed for coupons/tax/reporting/future B2B pricing.' );
		$this->assertSame( $product->get_id(), $item->get_product_id() );

		$wc_order_id = $wpdb->get_var( $wpdb->prepare( "SELECT wc_order_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking['booking_id'] ) );
		$this->assertSame( (string) $order->get_id(), $wc_order_id, 'The booking row must store the linked WooCommerce order id.' );
	}

	public function test_payment_complete_confirms_the_booking(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_id, $slot_id );
		$product         = $this->make_product( 'میکاپ عروس', 2500000 );
		$order           = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );

		$order->payment_complete();

		$this->assertSame( BookingService::STATUS_CONFIRMED, $booking_service->find( $booking['booking_id'] )['status'] );
	}

	public function test_order_cancelling_cancels_the_booking_and_releases_the_slot(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_id, $slot_id );
		$product         = $this->make_product( 'میکاپ عروس', 2500000 );
		$order           = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );

		$order->update_status( 'cancelled' );

		$this->assertSame( BookingService::STATUS_CANCELLED, $booking_service->find( $booking['booking_id'] )['status'] );

		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $slot_id ) );
		$this->assertSame( 'open', $slot_status, 'Cancelling the order must release the slot, same as cancelling the booking directly.' );
	}

	/**
	 * The scenario the architectural review specifically raised: payment
	 * completes for a booking whose hold already expired (and was
	 * cancelled by the sweep). confirm_booking() correctly refuses; the
	 * money must not just vanish — it's auto-refunded and the order gets
	 * an unmistakable note.
	 */
	public function test_payment_completing_after_the_booking_already_expired_triggers_a_refund(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_id, $slot_id );
		$product         = $this->make_product( 'میکاپ عروس', 2500000 );
		$order           = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );

		// The hold expires and the sweep cancels the booking before payment lands.
		$booking_service->expire_stale_holds();
		global $wpdb;
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - HOUR_IN_SECONDS ) ], [ 'id' => $booking['booking_id'] ] );
		$booking_service->expire_stale_holds();
		$this->assertSame( BookingService::STATUS_CANCELLED, $booking_service->find( $booking['booking_id'] )['status'] );

		$order->payment_complete();

		$order = wc_get_order( $order->get_id() );
		$this->assertGreaterThan( 0, count( $order->get_refunds() ), 'A payment completing for an already-expired booking must be automatically refunded.' );
	}

	/**
	 * GAP-03 (V2.4 Step 26 part 2): a second call for a booking that already
	 * has an order must return the SAME order, never create an orphaned
	 * second one and silently overwrite wc_order_id.
	 */
	public function test_a_second_call_for_the_same_booking_returns_the_existing_order_instead_of_a_new_one(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$booking = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot_id );
		$product = $this->make_product( 'میکاپ عروس', 2500000 );
		$bridge  = new BookingOrderBridge();

		$first  = $bridge->create_order_for_booking( $booking['booking_id'], $customer_id, $product );
		$second = $bridge->create_order_for_booking( $booking['booking_id'], $customer_id, $product );

		$this->assertSame( $first->get_id(), $second->get_id(), 'A repeated call for the same booking_id must return the exact same order, not a duplicate.' );

		$wc_order_id = $wpdb->get_var( $wpdb->prepare( "SELECT wc_order_id FROM {$wpdb->prefix}bc_bookings WHERE id = %d", $booking['booking_id'] ) );
		$this->assertSame( (string) $first->get_id(), $wc_order_id, 'The booking must still point at the original order, never overwritten by the second call.' );
	}

	public function test_the_booking_create_endpoint_attaches_a_pay_url_when_payments_is_active(): void {
		$result = apply_filters(
			'beauclick/booking/after_create',
			[ 'booking_id' => 1 ],
			[ 'booking_id' => 1, 'customer_id' => self::factory()->user->create(), 'provider_id' => self::factory()->user->create(), 'service_id' => null ]
		);

		$this->assertArrayHasKey( 'payUrl', $result );
		$this->assertIsString( $result['payUrl'] );
	}
}
