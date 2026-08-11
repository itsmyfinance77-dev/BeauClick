<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;

/**
 * The customer dashboard's own order history. WooCommerce's Store API has
 * no "my orders" endpoint (it's cart-scoped, not account-scoped), and
 * wc/v3 orders requires REST API keys meant for server-to-server
 * integrations, not a same-origin logged-in shopper — so this is a small,
 * explicitly ownership-scoped wrapper around wc_get_orders(), never
 * accepting a customer_id from the request.
 */
final class MyOrdersController extends RestController {

	public function register_routes(): void {
		$this->route( '/payments/my/orders', [ 'methods' => 'GET', 'callback' => [ $this, 'list_orders' ], 'permission_callback' => [ $this, 'require_login' ] ] );
	}

	public function list_orders(): \WP_REST_Response {
		$orders = wc_get_orders(
			[
				'customer' => get_current_user_id(),
				'limit'    => 20,
				'orderby'  => 'date',
				'order'    => 'DESC',
			]
		);

		return Response::ok( array_map( [ $this, 'format_order' ], $orders ) );
	}

	private function format_order( \WC_Order $order ): array {
		return [
			'id'            => $order->get_id(),
			'number'        => $order->get_order_number(),
			'status'        => $order->get_status(),
			'total'         => (int) $order->get_total(),
			'date'          => $order->get_date_created() ? $order->get_date_created()->date( 'Y-m-d H:i:s' ) : null,
			'itemCount'     => $order->get_item_count(),
			'viewUrl'       => $order->get_view_order_url(),
		];
	}
}
