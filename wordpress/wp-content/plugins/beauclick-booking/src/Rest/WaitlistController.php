<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rest;

use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * Customer routes are self-scoped (get_current_user_id() only). The
 * provider-facing list uses ProviderLookup::for_user() to resolve the
 * caller's own provider id -- never a client-supplied provider_id -- the
 * same ownership pattern BookingController::can_confirm() already
 * established for "is this professional's own data".
 */
final class WaitlistController extends RestController {

	public function register_routes(): void {
		$this->route( '/booking/waitlist', [ 'methods' => 'POST', 'callback' => [ $this, 'create' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/booking/waitlist/mine', [ 'methods' => 'GET', 'callback' => [ $this, 'mine' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/booking/waitlist/provider', [ 'methods' => 'GET', 'callback' => [ $this, 'provider_list' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/booking/waitlist/(?P<id>\d+)/cancel',
			[ 'methods' => 'POST', 'callback' => [ $this, 'cancel' ], 'permission_callback' => [ $this, 'can_cancel' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
	}

	public function can_cancel( WP_REST_Request $request ): bool|\WP_Error {
		$entry = ( new WaitlistService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $entry ) {
			return true; // Let the handler 404.
		}
		return $this->require_owner_or_capability( $entry['customerId'], 'bc_manage_platform' );
	}

	public function create( WP_REST_Request $request ) {
		$result = ( new WaitlistService() )->create(
			get_current_user_id(),
			(int) $request->get_param( 'provider_id' ),
			$request->get_param( 'service_id' ) ? (int) $request->get_param( 'service_id' ) : null,
			$request->get_param( 'preferred_date' ) ? (string) $request->get_param( 'preferred_date' ) : null,
			$request->get_param( 'time_start' ) ? (string) $request->get_param( 'time_start' ) : null,
			$request->get_param( 'time_end' ) ? (string) $request->get_param( 'time_end' ) : null
		);

		return is_string( $result )
			? Response::error( 'bc_invalid_waitlist_entry', $result, 422 )
			: Response::ok( $result, [], 201 );
	}

	public function mine(): \WP_REST_Response {
		return Response::ok( ( new WaitlistService() )->for_user( get_current_user_id() ) );
	}

	public function provider_list() {
		$provider_id = ProviderLookup::for_user( get_current_user_id() );
		if ( ! $provider_id ) {
			return Response::ok( [] ); // Not a professional/business -- an empty list, not an error, matching MyProfileController's own "no profile yet" convention.
		}
		return Response::ok( ( new WaitlistService() )->for_provider( $provider_id ) );
	}

	public function cancel( WP_REST_Request $request ) {
		$ok = ( new WaitlistService() )->cancel( (int) $request->get_param( 'id' ) );
		return $ok
			? Response::ok( [ 'cancelled' => true ] )
			: Response::error( 'bc_cannot_cancel', __( 'این درخواست دیگر قابل لغو نیست.', 'beauclick-booking' ), 409 );
	}
}
