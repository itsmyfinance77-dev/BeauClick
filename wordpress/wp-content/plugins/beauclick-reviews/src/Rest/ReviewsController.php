<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Reviews\Reviews\ReviewService;
use WP_REST_Request;

final class ReviewsController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/reviews/providers/(?P<id>\d+)',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'for_provider' ],
				'permission_callback' => '__return_true',
				'args'                => [ 'id' => [ 'type' => 'integer', 'required' => true ] ],
			]
		);

		$this->route(
			'/reviews',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'create' ],
				'permission_callback' => [ $this, 'can_write' ],
				'args'                => [
					'booking_id' => [ 'type' => 'integer', 'required' => true ],
					'rating'     => [ 'type' => 'integer', 'required' => true ],
					'body'       => [ 'type' => 'string', 'required' => false ],
				],
			]
		);

		$this->route(
			'/reviews/my',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'my_reviews' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);

		$this->route(
			'/reviews/(?P<id>\d+)/respond',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'respond' ],
				'permission_callback' => [ $this, 'require_login' ],
				'args'                => [
					'id'       => [ 'type' => 'integer', 'required' => true ],
					'response' => [ 'type' => 'string', 'required' => true ],
				],
			]
		);
	}

	public function can_write(): bool|\WP_Error {
		return $this->require_capability( 'bc_write_review' );
	}

	public function for_provider( WP_REST_Request $request ) {
		$reviews = ( new ReviewService() )->for_provider( (int) $request->get_param( 'id' ) );
		return Response::ok( $reviews );
	}

	public function create( WP_REST_Request $request ) {
		$result = ( new ReviewService() )->create(
			get_current_user_id(),
			(int) $request->get_param( 'booking_id' ),
			(int) $request->get_param( 'rating' ),
			(string) ( $request->get_param( 'body' ) ?? '' )
		);

		if ( is_string( $result ) ) {
			return Response::error( 'bc_invalid_review', $result, 409 );
		}

		return Response::ok( $result, [], 201 );
	}

	public function my_reviews(): \WP_REST_Response {
		global $wpdb;
		$user_id      = get_current_user_id();
		$provider_ids = $wpdb->get_col(
			$wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_author = %d AND post_type IN ('bc_professional','bc_business') AND post_status = 'publish'", $user_id ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		if ( ! $provider_ids ) {
			return Response::ok( [] );
		}

		$service = new ReviewService();
		$all     = [];
		foreach ( $provider_ids as $provider_id ) {
			$all = array_merge( $all, $service->for_provider( (int) $provider_id, false ) );
		}
		usort( $all, static fn ( array $a, array $b ) => strcmp( $b['createdAt'], $a['createdAt'] ) );

		return Response::ok( $all );
	}

	public function respond( WP_REST_Request $request ) {
		$ok = ( new ReviewService() )->respond(
			(int) $request->get_param( 'id' ),
			get_current_user_id(),
			(string) $request->get_param( 'response' )
		);

		return $ok
			? Response::ok( [ 'responded' => true ] )
			: Response::error( 'bc_forbidden', __( 'شما اجازه پاسخ به این نظر را ندارید.', 'beauclick-reviews' ), 403 );
	}
}
