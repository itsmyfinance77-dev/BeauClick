<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\JourneySummaryService;
use BeauClick\Journey\Profile\BeautyProfileService;
use BeauClick\Journey\Timeline\TimelineComposer;
use WP_REST_Request;

/**
 * Every route here is self-scoped (get_current_user_id(), never a
 * customer_id/user_id request param) -- the same "there is no way to ask
 * for someone else's data" safety-by-construction MyOrdersController and
 * BookingController::list_own() already rely on. Goal mutation is the one
 * exception (a goal has its own id) and gets an explicit ownership check,
 * same pattern as MyProfileController::can_edit_service().
 */
final class JourneyController extends RestController {

	public function register_routes(): void {
		$this->route( '/journey/summary', [ 'methods' => 'GET', 'callback' => [ $this, 'summary' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route( '/journey/profile', [ 'methods' => 'GET', 'callback' => [ $this, 'get_profile' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/journey/profile', [ 'methods' => 'PATCH', 'callback' => [ $this, 'update_profile' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route( '/journey/goals', [ 'methods' => 'GET', 'callback' => [ $this, 'list_goals' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/journey/goals', [ 'methods' => 'POST', 'callback' => [ $this, 'create_goal' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/journey/goals/(?P<id>\d+)',
			[
				'methods'             => 'PATCH',
				'callback'            => [ $this, 'update_goal' ],
				'permission_callback' => [ $this, 'can_edit_goal' ],
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);

		$this->route( '/journey/timeline', [ 'methods' => 'GET', 'callback' => [ $this, 'timeline' ], 'permission_callback' => [ $this, 'require_login' ] ] );
	}

	public function can_edit_goal( WP_REST_Request $request ): bool|\WP_Error {
		$goal = ( new GoalService() )->find( (int) $request->get_param( 'id' ) );
		if ( ! $goal ) {
			return true; // Let the handler 404 -- permission isn't the interesting failure, same convention as MyProfileController::can_edit_service().
		}
		return $this->require_owner_or_capability( $goal['userId'], 'bc_manage_platform' );
	}

	public function summary(): \WP_REST_Response {
		return Response::ok( ( new JourneySummaryService() )->for_user( get_current_user_id() ) );
	}

	public function get_profile(): \WP_REST_Response {
		return Response::ok( ( new BeautyProfileService() )->get( get_current_user_id() ) );
	}

	public function update_profile( WP_REST_Request $request ): \WP_REST_Response {
		$fields = [];
		foreach ( [ 'preferredCityId', 'preferredSpecialtyIds', 'budgetMin', 'budgetMax', 'notes' ] as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$fields[ $key ] = $request->get_param( $key );
			}
		}
		return Response::ok( ( new BeautyProfileService() )->update( get_current_user_id(), $fields ) );
	}

	public function list_goals( WP_REST_Request $request ): \WP_REST_Response {
		$status = $request->get_param( 'status' ) ? sanitize_key( (string) $request->get_param( 'status' ) ) : null;
		return Response::ok( ( new GoalService() )->for_user( get_current_user_id(), $status ) );
	}

	public function create_goal( WP_REST_Request $request ): \WP_REST_Response {
		$result = ( new GoalService() )->create(
			get_current_user_id(),
			(string) $request->get_param( 'title' ),
			$request->get_param( 'specialty_id' ) ? (int) $request->get_param( 'specialty_id' ) : null,
			$request->get_param( 'city_id' ) ? (int) $request->get_param( 'city_id' ) : null,
			$request->get_param( 'budget' ) ? (int) $request->get_param( 'budget' ) : null,
			$request->get_param( 'target_date' ) ? (string) $request->get_param( 'target_date' ) : null
		);

		return is_string( $result )
			? Response::error( 'bc_invalid_goal', $result, 400 )
			: Response::ok( $result, [], 201 );
	}

	public function update_goal( WP_REST_Request $request ): \WP_REST_Response {
		$fields = [];
		foreach ( [ 'title', 'status' ] as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$fields[ $key ] = $request->get_param( $key );
			}
		}
		foreach ( [ 'specialty_id' => 'specialtyId', 'city_id' => 'cityId', 'budget' => 'budget', 'target_date' => 'targetDate' ] as $param => $field ) {
			if ( null !== $request->get_param( $param ) ) {
				$fields[ $field ] = $request->get_param( $param );
			}
		}

		$result = ( new GoalService() )->update( (int) $request->get_param( 'id' ), $fields );

		return is_string( $result )
			? Response::error( 'bc_invalid_goal', $result, 400 )
			: Response::ok( $result );
	}

	public function timeline( WP_REST_Request $request ): \WP_REST_Response {
		[ $page, $per_page ] = $this->pagination_args( $request, 20, 50 );
		$offset = ( $page - 1 ) * $per_page;

		$entries = ( new TimelineComposer() )->for_user( get_current_user_id(), $per_page, $offset );

		return Response::ok( $entries );
	}
}
