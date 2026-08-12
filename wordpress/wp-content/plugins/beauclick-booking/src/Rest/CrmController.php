<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rest;

use BeauClick\Booking\Crm\CrmService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * V2.1 Step 5 — Professional CRM. Lives in beauclick-booking, not a new
 * plugin, matching architecture doc §4.5's own conclusion ("folded into
 * beauclick-booking's DashboardController as a natural extension") and the
 * exact same reasoning V2.0 Step 3 already used to place Ranking here
 * instead of marketplace: this data starts from wp_bc_bookings, which
 * booking already owns.
 *
 * Every route resolves "which provider is the current user" via
 * ProviderLookup — never a request-supplied provider id — then every
 * customer-scoped read/write re-checks CrmService::is_customer_of() before
 * touching anything. There is no way to ask this controller for another
 * professional's customer data by supplying a different id; a customer_id
 * that doesn't genuinely belong to the caller's own provider is treated
 * identically to one that doesn't exist at all.
 */
final class CrmController extends RestController {

	public function register_routes(): void {
		$this->route( '/booking/crm/customers', [ 'methods' => 'GET', 'callback' => [ $this, 'list_customers' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/booking/crm/customers/(?P<id>\d+)',
			[ 'methods' => 'GET', 'callback' => [ $this, 'customer_detail' ], 'permission_callback' => [ $this, 'require_login' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
		$this->route(
			'/booking/crm/customers/(?P<id>\d+)/notes',
			[ 'methods' => 'POST', 'callback' => [ $this, 'add_note' ], 'permission_callback' => [ $this, 'require_login' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
	}

	private function current_provider_id(): ?int {
		return ProviderLookup::for_user( get_current_user_id() );
	}

	public function list_customers( WP_REST_Request $request ): \WP_REST_Response {
		$provider_id = $this->current_provider_id();
		if ( ! $provider_id ) {
			return Response::paginated( [], 0, 1, 20 );
		}

		[ $page, $per_page ] = $this->pagination_args( $request, 20, 100 );
		$search = trim( (string) $request->get_param( 'search' ) );
		$filter = (string) ( $request->get_param( 'filter' ) ?: 'all' );

		$result = ( new CrmService() )->list_customers( $provider_id, $search, $filter, $page, $per_page );

		return Response::paginated( $result['items'], $result['total'], $page, $per_page );
	}

	public function customer_detail( WP_REST_Request $request ) {
		$provider_id = $this->current_provider_id();
		$customer_id = (int) $request->get_param( 'id' );

		$detail = $provider_id ? ( new CrmService() )->get_customer_detail( $provider_id, $customer_id ) : null;
		if ( ! $detail ) {
			return Response::error( 'bc_not_found', __( 'این مشتری پیدا نشد یا در اختیار شما نیست.', 'beauclick-booking' ), 404 );
		}

		return Response::ok( $detail );
	}

	public function add_note( WP_REST_Request $request ) {
		$provider_id = $this->current_provider_id();
		$customer_id = (int) $request->get_param( 'id' );
		$note_text   = (string) $request->get_param( 'note' );

		if ( trim( $note_text ) === '' ) {
			return Response::error( 'bc_invalid_input', __( 'متن یادداشت نمی‌تواند خالی باشد.', 'beauclick-booking' ), 422 );
		}

		$note = $provider_id ? ( new CrmService() )->add_note( $provider_id, $customer_id, get_current_user_id(), $note_text ) : null;
		if ( ! $note ) {
			return Response::error( 'bc_not_found', __( 'این مشتری پیدا نشد یا در اختیار شما نیست.', 'beauclick-booking' ), 404 );
		}

		return Response::ok( $note, [], 201 );
	}
}
