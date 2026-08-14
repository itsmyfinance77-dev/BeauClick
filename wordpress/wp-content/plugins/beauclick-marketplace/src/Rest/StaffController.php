<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Staff\StaffService;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * V2.2 Step 16 — self-service staff management, owner-only (a staff member
 * cannot add/remove other staff in this minimal model — see StaffService's
 * own scope-boundary docblock). "Which business" is always resolved from
 * the caller's own session via ProviderLookup, never a request-supplied id.
 */
final class StaffController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/marketplace/my/staff',
			[
				[ 'methods' => 'GET', 'callback' => [ $this, 'list_staff' ], 'permission_callback' => [ $this, 'can_manage_staff' ] ],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'add_staff' ],
					'permission_callback' => [ $this, 'can_manage_staff' ],
					'args'                => [ 'phone' => [ 'type' => 'string', 'required' => true ] ],
				],
			]
		);

		$this->route(
			'/marketplace/my/staff/(?P<user_id>\d+)',
			[
				'methods'             => 'DELETE',
				'callback'            => [ $this, 'remove_staff' ],
				'permission_callback' => [ $this, 'can_manage_staff' ],
				'args'                => [ 'user_id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	/**
	 * Only the genuine owner (post_author) — never an authorized staff
	 * member — may manage the staff list itself, deliberately excluding
	 * staff-managing-staff from this minimal model.
	 */
	private function owned_business_id(): ?int {
		$user_id     = get_current_user_id();
		$provider_id = ProviderLookup::for_user( $user_id );
		if ( ! $provider_id ) {
			return null;
		}
		$provider = get_post( $provider_id );
		return ( $provider && (int) $provider->post_author === $user_id ) ? $provider_id : null;
	}

	public function can_manage_staff(): bool|\WP_Error {
		return $this->owned_business_id()
			? true
			: new \WP_Error( 'bc_forbidden', __( 'شما اجازه مدیریت کارکنان را ندارید.', 'beauclick-marketplace' ), [ 'status' => 403 ] );
	}

	public function list_staff(): \WP_REST_Response {
		$business_id = $this->owned_business_id();
		return Response::ok( $business_id ? ( new StaffService() )->list_for_business( $business_id ) : [] );
	}

	public function add_staff( WP_REST_Request $request ) {
		$business_id = $this->owned_business_id();
		$phone       = (string) $request->get_param( 'phone' );

		$result = $business_id ? ( new StaffService() )->add( $business_id, $phone, get_current_user_id() ) : StaffService::ERROR_NOT_FOUND;

		if ( is_array( $result ) ) {
			return Response::ok( $result, [], 201 );
		}

		return match ( $result ) {
			StaffService::ERROR_IS_OWNER      => Response::error( 'bc_is_owner', __( 'این کاربر همان مالک کسب‌وکار است.', 'beauclick-marketplace' ), 400 ),
			StaffService::ERROR_ALREADY_STAFF => Response::error( 'bc_already_staff', __( 'این کاربر از قبل عضو تیم شماست.', 'beauclick-marketplace' ), 400 ),
			default                            => Response::error( 'bc_user_not_found', __( 'کاربری با این شماره تماس پیدا نشد.', 'beauclick-marketplace' ), 404 ),
		};
	}

	public function remove_staff( WP_REST_Request $request ) {
		$business_id = $this->owned_business_id();
		$user_id     = (int) $request->get_param( 'user_id' );

		$ok = $business_id && ( new StaffService() )->remove( $business_id, $user_id );

		return $ok
			? Response::ok( [ 'removed' => true ] )
			: Response::error( 'bc_not_found', __( 'این عضو تیم پیدا نشد.', 'beauclick-marketplace' ), 404 );
	}
}
