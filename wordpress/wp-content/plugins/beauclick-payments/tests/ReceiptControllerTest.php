<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Payments\Booking\BookingOrderBridge;
use BeauClick\Payments\Rest\ReceiptController;
use WP_UnitTestCase;

final class ReceiptControllerTest extends WP_UnitTestCase {

	private function make_slot( int $provider_id, string $start ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => $start, 'end_at' => gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
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

	private function make_paid_booking_with_order( int $provider_id, int $customer_id, int $price = 2500000 ): array {
		$slot            = $this->make_slot( $provider_id, gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS ) );
		$booking_service = new BookingService();
		$booking         = $booking_service->create_booking( $customer_id, $provider_id, $slot );
		$product         = $this->make_product( 'میکاپ عروس', $price );
		$order           = ( new BookingOrderBridge() )->create_order_for_booking( $booking['booking_id'], $customer_id, $product );
		$order->payment_complete();

		return [ 'booking_id' => $booking['booking_id'], 'order' => $order ];
	}

	// 27. Receipt values match the WooCommerce order -- the single financial source of truth.
	public function test_the_booking_receipt_total_matches_the_real_order_total(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$made        = $this->make_paid_booking_with_order( $provider_id, $customer_id, 2500000 );

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/bookings/{$made['booking_id']}/receipt" );
		$request->set_param( 'id', $made['booking_id'] );

		$data = ( new ReceiptController() )->booking_receipt( $request )->get_data()['data'];

		$this->assertSame( 2500000.0, $data['total'] );
		$this->assertSame( $made['order']->get_id(), $data['orderId'] );
		$this->assertNotNull( $data['appointmentAtJalali'], 'The receipt must render the appointment date in Jalali, not only Gregorian.' );
	}

	// 28. Receipt access is self-scoped.
	public function test_an_unrelated_customer_cannot_view_someone_elses_booking_receipt(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$stranger_id = self::factory()->user->create();
		$made        = $this->make_paid_booking_with_order( $provider_id, $customer_id );

		wp_set_current_user( $stranger_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/bookings/{$made['booking_id']}/receipt" );
		$request->set_param( 'id', $made['booking_id'] );

		$this->assertInstanceOf( \WP_Error::class, ( new ReceiptController() )->can_view_booking_receipt( $request ) );
	}

	public function test_the_owning_customer_can_view_their_own_booking_receipt(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$made        = $this->make_paid_booking_with_order( $provider_id, $customer_id );

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/bookings/{$made['booking_id']}/receipt" );
		$request->set_param( 'id', $made['booking_id'] );

		$this->assertTrue( ( new ReceiptController() )->can_view_booking_receipt( $request ) );
	}

	public function test_a_booking_with_no_linked_order_yet_still_returns_a_usable_receipt_shape(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot        = $this->make_slot( $provider_id, gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS ) );
		$booking     = ( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $customer_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/bookings/{$booking['booking_id']}/receipt" );
		$request->set_param( 'id', $booking['booking_id'] );

		$data = ( new ReceiptController() )->booking_receipt( $request )->get_data()['data'];
		$this->assertNull( $data['total'], 'With no linked order yet, the receipt must honestly show no total rather than fabricating one.' );
		$this->assertSame( $booking['booking_id'], $data['bookingId'] );
	}

	public function test_order_receipt_is_scoped_to_the_orders_own_customer(): void {
		$customer_id = self::factory()->user->create();
		$stranger_id = self::factory()->user->create();
		$product     = $this->make_product( 'بسته عمده', 1000000 );
		$order       = wc_create_order( [ 'customer_id' => $customer_id ] );
		$order->add_product( $product, 1 );
		$order->calculate_totals();
		$order->save();

		wp_set_current_user( $customer_id );
		$owner_request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/orders/{$order->get_id()}/receipt" );
		$owner_request->set_param( 'id', $order->get_id() );
		$this->assertTrue( ( new ReceiptController() )->can_view_order_receipt( $owner_request ) );

		wp_set_current_user( $stranger_id );
		$this->assertInstanceOf( \WP_Error::class, ( new ReceiptController() )->can_view_order_receipt( $owner_request ) );
	}

	public function test_a_platform_admin_can_view_any_booking_receipt(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$admin_id    = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$made        = $this->make_paid_booking_with_order( $provider_id, $customer_id );

		wp_set_current_user( $admin_id );
		$request = new \WP_REST_Request( 'GET', "/beauclick/v1/payments/bookings/{$made['booking_id']}/receipt" );
		$request->set_param( 'id', $made['booking_id'] );

		$this->assertTrue( ( new ReceiptController() )->can_view_booking_receipt( $request ) );
	}
}
