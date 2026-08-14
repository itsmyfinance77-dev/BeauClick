<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rest;

use BeauClick\Booking\Availability\AvailabilityService;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * V2.2 Step 16 — a professional/business's own self-service availability
 * management (see AvailabilityService's own docblock for why this exists at
 * all: before this controller, no real code path let a professional create
 * a bookable slot). Every route resolves "which provider" from the caller's
 * own session via ProviderLookup — never a request-supplied provider id —
 * matching the exact same pattern MyProfileController/CrmController/
 * DashboardController already use.
 */
final class AvailabilityController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/booking/my/availability',
			[
				[ 'methods' => 'GET', 'callback' => [ $this, 'list_own' ], 'permission_callback' => [ $this, 'can_manage_own_availability' ] ],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'create_slot' ],
					'permission_callback' => [ $this, 'can_manage_own_availability' ],
					'args'                => [
						'start_at' => [ 'type' => 'string', 'required' => true ],
						'end_at'   => [ 'type' => 'string', 'required' => true ],
					],
				],
			]
		);

		$this->route(
			'/booking/my/availability/bulk',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'bulk_generate' ],
				'permission_callback' => [ $this, 'can_manage_own_availability' ],
				'args'                => [
					'weekdays'     => [ 'type' => 'array', 'required' => true ],
					'time_start'   => [ 'type' => 'string', 'required' => true ],
					'time_end'     => [ 'type' => 'string', 'required' => true ],
					'slot_minutes' => [ 'type' => 'integer', 'required' => true ],
					'date_from'    => [ 'type' => 'string', 'required' => true ],
					'date_to'      => [ 'type' => 'string', 'required' => true ],
				],
			]
		);

		$this->route(
			'/booking/my/availability/(?P<id>\d+)',
			[
				'methods'             => 'DELETE',
				'callback'            => [ $this, 'delete_slot' ],
				'permission_callback' => [ $this, 'can_manage_own_availability' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);
	}

	public function can_manage_own_availability(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_own_availability' );
	}

	private function current_provider_id(): ?int {
		return ProviderLookup::for_user( get_current_user_id() );
	}

	public function list_own(): \WP_REST_Response {
		$provider_id = $this->current_provider_id();
		return Response::ok( $provider_id ? ( new AvailabilityService() )->list_own( $provider_id ) : [] );
	}

	public function create_slot( WP_REST_Request $request ) {
		$provider_id = $this->current_provider_id();
		if ( ! $provider_id ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص ندارید.', 'beauclick-booking' ), 404 );
		}

		$service_id = $request->get_param( 'service_id' ) ? (int) $request->get_param( 'service_id' ) : null;
		$result     = ( new AvailabilityService() )->create_slot( $provider_id, (string) $request->get_param( 'start_at' ), (string) $request->get_param( 'end_at' ), $service_id );

		if ( is_array( $result ) ) {
			return Response::ok( $result, [], 201 );
		}

		return match ( $result ) {
			AvailabilityService::ERROR_IN_PAST  => Response::error( 'bc_slot_in_past', __( 'زمان انتخاب‌شده در گذشته است.', 'beauclick-booking' ), 422 ),
			AvailabilityService::ERROR_OVERLAPS => Response::error( 'bc_slot_overlaps', __( 'این بازه زمانی با یکی از زمان‌های موجود شما تداخل دارد.', 'beauclick-booking' ), 409 ),
			default                              => Response::error( 'bc_invalid_range', __( 'بازه زمانی نامعتبر است.', 'beauclick-booking' ), 422 ),
		};
	}

	public function bulk_generate( WP_REST_Request $request ) {
		$provider_id = $this->current_provider_id();
		if ( ! $provider_id ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص ندارید.', 'beauclick-booking' ), 404 );
		}

		$service_id = $request->get_param( 'service_id' ) ? (int) $request->get_param( 'service_id' ) : null;
		$result     = ( new AvailabilityService() )->bulk_generate(
			$provider_id,
			array_map( 'intval', (array) $request->get_param( 'weekdays' ) ),
			(string) $request->get_param( 'time_start' ),
			(string) $request->get_param( 'time_end' ),
			(int) $request->get_param( 'slot_minutes' ),
			(string) $request->get_param( 'date_from' ),
			(string) $request->get_param( 'date_to' ),
			$service_id
		);

		if ( is_array( $result ) ) {
			return Response::ok( $result );
		}

		return Response::error( 'bc_invalid_range', __( 'ورودی‌های وارد‌شده معتبر نیست — بازه زمانی، مدت هر نوبت یا بازه تاریخ را بررسی کنید.', 'beauclick-booking' ), 422 );
	}

	public function delete_slot( WP_REST_Request $request ) {
		$provider_id = $this->current_provider_id();
		$ok          = $provider_id && ( new AvailabilityService() )->delete_slot( $provider_id, (int) $request->get_param( 'id' ) );

		return $ok
			? Response::ok( [ 'deleted' => true ] )
			: Response::error( 'bc_cannot_delete_slot', __( 'این زمان قابل حذف نیست — ممکن است متعلق به شما نباشد یا رزرو‌شده باشد.', 'beauclick-booking' ), 409 );
	}
}
