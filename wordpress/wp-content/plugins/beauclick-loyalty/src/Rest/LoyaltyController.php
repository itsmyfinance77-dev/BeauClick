<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\LoyaltyLedger;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Loyalty\Tiers\TierService;
use WP_REST_Request;

/**
 * Customer-facing routes are self-scoped via get_current_user_id() only --
 * the same "there is no way to ask for someone else's data" pattern
 * JourneyController/MyOrdersController already established; no route here
 * ever accepts a customer-supplied user_id. Admin routes (tier/plan/benefit
 * configuration, manual membership grant/revoke) require bc_manage_platform,
 * verified server-side, matching the capability every other platform-config
 * admin surface in this codebase already uses.
 */
final class LoyaltyController extends RestController {

	public function register_routes(): void {
		$this->route( '/loyalty/summary', [ 'methods' => 'GET', 'callback' => [ $this, 'summary' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/loyalty/tiers', [ 'methods' => 'GET', 'callback' => [ $this, 'public_tiers' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route( '/loyalty/admin/tiers', [ 'methods' => 'GET', 'callback' => [ $this, 'admin_list_tiers' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route( '/loyalty/admin/tiers', [ 'methods' => 'POST', 'callback' => [ $this, 'admin_create_tier' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route(
			'/loyalty/admin/tiers/(?P<id>\d+)',
			[ 'methods' => 'PATCH', 'callback' => [ $this, 'admin_update_tier' ], 'permission_callback' => [ $this, 'require_admin' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);

		$this->route( '/loyalty/admin/plans', [ 'methods' => 'GET', 'callback' => [ $this, 'admin_list_plans' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route( '/loyalty/admin/plans', [ 'methods' => 'POST', 'callback' => [ $this, 'admin_create_plan' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route(
			'/loyalty/admin/plans/(?P<id>\d+)',
			[ 'methods' => 'PATCH', 'callback' => [ $this, 'admin_update_plan' ], 'permission_callback' => [ $this, 'require_admin' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);

		$this->route( '/loyalty/admin/benefits', [ 'methods' => 'GET', 'callback' => [ $this, 'admin_list_benefits' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route( '/loyalty/admin/benefits', [ 'methods' => 'POST', 'callback' => [ $this, 'admin_create_benefit' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route(
			'/loyalty/admin/benefits/(?P<id>\d+)',
			[ 'methods' => 'PATCH', 'callback' => [ $this, 'admin_update_benefit' ], 'permission_callback' => [ $this, 'require_admin' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
		$this->route(
			'/loyalty/admin/benefits/(?P<id>\d+)',
			[ 'methods' => 'DELETE', 'callback' => [ $this, 'admin_delete_benefit' ], 'permission_callback' => [ $this, 'require_admin' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);

		$this->route( '/loyalty/admin/memberships/grant', [ 'methods' => 'POST', 'callback' => [ $this, 'admin_grant_membership' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
		$this->route(
			'/loyalty/admin/memberships/(?P<user_id>\d+)/cancel',
			[ 'methods' => 'POST', 'callback' => [ $this, 'admin_cancel_membership' ], 'permission_callback' => [ $this, 'require_admin' ], 'args' => [ 'user_id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
	}

	public function require_admin(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function summary(): \WP_REST_Response {
		$user_id = get_current_user_id();
		$ledger  = new LoyaltyLedger();
		$tier    = new TierService();
		$benefit = new BenefitService();

		return Response::ok(
			[
				'balance'        => $ledger->balance( $user_id ),
				'lifetimeEarned' => $ledger->lifetime_earned( $user_id ),
				'progress'       => $tier->progress_for_user( $user_id ),
				'membership'     => ( new MembershipService() )->for_user( $user_id ),
				'benefits'       => $benefit->benefits_for_user( $user_id ),
				'history'        => $ledger->history( $user_id, 30 ),
			]
		);
	}

	public function public_tiers(): \WP_REST_Response {
		return Response::ok( ( new TierService() )->all( true ) );
	}

	public function admin_list_tiers(): \WP_REST_Response {
		return Response::ok( ( new TierService() )->all( false ) );
	}

	public function admin_create_tier( WP_REST_Request $request ) {
		$result = ( new TierService() )->create(
			(string) $request->get_param( 'slug' ),
			(string) $request->get_param( 'name' ),
			(int) $request->get_param( 'thresholdPoints' ),
			(int) ( $request->get_param( 'sortOrder' ) ?? 0 )
		);
		return is_string( $result ) ? Response::error( 'bc_invalid_tier', $result, 422 ) : Response::ok( $result, [], 201 );
	}

	public function admin_update_tier( WP_REST_Request $request ) {
		$fields = [];
		foreach ( [ 'name', 'thresholdPoints', 'sortOrder', 'isActive' ] as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$fields[ $key ] = $request->get_param( $key );
			}
		}
		$result = ( new TierService() )->update( (int) $request->get_param( 'id' ), $fields );
		return is_string( $result ) ? Response::error( 'bc_invalid_tier', $result, 422 ) : Response::ok( $result );
	}

	public function admin_list_plans(): \WP_REST_Response {
		return Response::ok( ( new MembershipService() )->plans( false ) );
	}

	public function admin_create_plan( WP_REST_Request $request ) {
		$result = ( new MembershipService() )->create_plan(
			(string) $request->get_param( 'slug' ),
			(string) $request->get_param( 'name' ),
			$request->get_param( 'tierId' ) ? (int) $request->get_param( 'tierId' ) : null,
			(bool) $request->get_param( 'isPaid' ),
			null !== $request->get_param( 'price' ) ? (int) $request->get_param( 'price' ) : null,
			null !== $request->get_param( 'billingPeriodDays' ) ? (int) $request->get_param( 'billingPeriodDays' ) : null,
			(int) ( $request->get_param( 'sortOrder' ) ?? 0 )
		);
		return is_string( $result ) ? Response::error( 'bc_invalid_plan', $result, 422 ) : Response::ok( $result, [], 201 );
	}

	public function admin_update_plan( WP_REST_Request $request ) {
		$fields = [];
		foreach ( [ 'name', 'tierId', 'isPaid', 'price', 'isActive' ] as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$fields[ $key ] = $request->get_param( $key );
			}
		}
		$result = ( new MembershipService() )->update_plan( (int) $request->get_param( 'id' ), $fields );
		return is_string( $result ) ? Response::error( 'bc_invalid_plan', $result, 422 ) : Response::ok( $result );
	}

	public function admin_list_benefits( WP_REST_Request $request ): \WP_REST_Response {
		$source_type = (string) $request->get_param( 'sourceType' );
		$source_id   = (int) $request->get_param( 'sourceId' );
		return Response::ok( ( new BenefitService() )->for_source( $source_type, $source_id, false ) );
	}

	public function admin_create_benefit( WP_REST_Request $request ) {
		$config = $request->get_param( 'config' );
		$result = ( new BenefitService() )->create(
			(string) $request->get_param( 'sourceType' ),
			(int) $request->get_param( 'sourceId' ),
			(string) $request->get_param( 'benefitType' ),
			(string) $request->get_param( 'label' ),
			is_array( $config ) ? $config : [],
			(int) ( $request->get_param( 'sortOrder' ) ?? 0 )
		);
		return is_string( $result ) ? Response::error( 'bc_invalid_benefit', $result, 422 ) : Response::ok( $result, [], 201 );
	}

	public function admin_update_benefit( WP_REST_Request $request ): \WP_REST_Response {
		$fields = [];
		foreach ( [ 'label', 'config', 'isActive' ] as $key ) {
			if ( null !== $request->get_param( $key ) ) {
				$fields[ $key ] = $request->get_param( $key );
			}
		}
		( new BenefitService() )->update( (int) $request->get_param( 'id' ), $fields );
		return Response::ok( [ 'ok' => true ] );
	}

	public function admin_delete_benefit( WP_REST_Request $request ): \WP_REST_Response {
		( new BenefitService() )->delete( (int) $request->get_param( 'id' ) );
		return Response::ok( [ 'ok' => true ] );
	}

	public function admin_grant_membership( WP_REST_Request $request ) {
		$user_id = (int) $request->get_param( 'userId' );
		$plan_id = (int) $request->get_param( 'planId' );
		if ( ! $user_id || ! $plan_id ) {
			return Response::error( 'bc_invalid_grant', 'کاربر و پلن عضویت الزامی است.', 422 );
		}

		$result = ( new MembershipService() )->activate( $user_id, $plan_id, 'manual', get_current_user_id() );
		return is_string( $result ) ? Response::error( 'bc_invalid_grant', $result, 422 ) : Response::ok( $result, [], 201 );
	}

	public function admin_cancel_membership( WP_REST_Request $request ) {
		$result = ( new MembershipService() )->cancel( (int) $request->get_param( 'user_id' ), get_current_user_id() );
		return is_string( $result ) ? Response::error( 'bc_invalid_cancel', $result, 422 ) : Response::ok( [ 'ok' => true ] );
	}
}
