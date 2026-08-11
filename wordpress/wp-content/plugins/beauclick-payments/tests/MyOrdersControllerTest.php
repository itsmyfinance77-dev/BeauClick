<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Payments\Rest\MyOrdersController;
use WP_UnitTestCase;

final class MyOrdersControllerTest extends WP_UnitTestCase {

	private function make_order_for( int $customer_id ): \WC_Order {
		$order = new \WC_Order();
		$order->set_customer_id( $customer_id );
		$order->set_status( 'processing' );
		$order->save();
		return $order;
	}

	/**
	 * wc_get_orders() is called with ['customer' => get_current_user_id()]
	 * and the request never supplies a customer id — this asserts that
	 * scoping actually holds, i.e. one shopper's order history is never
	 * returned to a different logged-in shopper.
	 */
	public function test_a_customer_only_sees_their_own_orders(): void {
		$customer_a = self::factory()->user->create();
		$customer_b = self::factory()->user->create();

		$this->make_order_for( $customer_a );
		$order_b = $this->make_order_for( $customer_b );

		wp_set_current_user( $customer_b );
		$response = ( new MyOrdersController() )->list_orders();
		$data     = $response->get_data()['data'];

		$this->assertCount( 1, $data );
		$this->assertSame( $order_b->get_id(), $data[0]['id'] );
	}

	public function test_orders_route_requires_login(): void {
		wp_set_current_user( 0 );
		$controller = new MyOrdersController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}
}
