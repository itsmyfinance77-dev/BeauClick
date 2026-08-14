<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Rest;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use BeauClick\Payments\Receipt\ReceiptPresenter;
use WP_REST_Request;

/**
 * V2.2 Step 15 (COM-04) — a receipt for a booking (appointment + payment
 * together, a view that did not exist anywhere before this step) and for a
 * plain WooCommerce order (B2B/shop). Read-only, ownership-scoped: the
 * customer only ever sees their own; for a booking receipt, the owning
 * professional and a platform admin may also see it — the same three-way
 * gate BookingController already uses for confirm/cancel/reschedule, since
 * they have the same pre-existing legitimate reason to see this booking's
 * data. Never exposes an arbitrary order by guessable id to a stranger.
 */
final class ReceiptController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/payments/bookings/(?P<id>\d+)/receipt',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'booking_receipt' ],
				'permission_callback' => [ $this, 'can_view_booking_receipt' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);

		$this->route(
			'/payments/orders/(?P<id>\d+)/receipt',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'order_receipt' ],
				'permission_callback' => [ $this, 'can_view_order_receipt' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_view_booking_receipt( WP_REST_Request $request ): bool|\WP_Error {
		$booking = ( new BookingService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $booking ) {
			return true; // Let the handler 404 — permission isn't the interesting failure here.
		}
		$user_id = get_current_user_id();
		if ( $user_id && $user_id === (int) $booking['customer_id'] ) {
			return true;
		}
		$my_provider_id = ProviderLookup::for_user( $user_id );
		if ( $my_provider_id && $my_provider_id === (int) $booking['provider_id'] ) {
			return true;
		}
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function can_view_order_receipt( WP_REST_Request $request ): bool|\WP_Error {
		$order = wc_get_order( (int) $request->get_param( 'id' ) );
		if ( ! $order instanceof \WC_Order ) {
			return true; // Let the handler 404.
		}
		return $this->require_owner_or_capability( (int) $order->get_customer_id(), 'bc_manage_platform' );
	}

	public function booking_receipt( WP_REST_Request $request ) {
		$booking = ( new BookingService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $booking ) {
			return Response::error( 'bc_not_found', __( 'رزرو پیدا نشد.', 'beauclick-payments' ), 404 );
		}

		$order = $booking['wc_order_id'] ? wc_get_order( (int) $booking['wc_order_id'] ) : null;

		return Response::ok( ( new ReceiptPresenter() )->for_booking( $booking, $order instanceof \WC_Order ? $order : null ) );
	}

	public function order_receipt( WP_REST_Request $request ) {
		$order = wc_get_order( (int) $request->get_param( 'id' ) );
		if ( ! $order instanceof \WC_Order ) {
			return Response::error( 'bc_not_found', __( 'سفارش پیدا نشد.', 'beauclick-payments' ), 404 );
		}

		return Response::ok( ( new ReceiptPresenter() )->for_order( $order ) );
	}
}
