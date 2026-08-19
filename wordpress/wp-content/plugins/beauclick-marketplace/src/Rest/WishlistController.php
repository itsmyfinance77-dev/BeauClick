<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Wishlist\WishlistService;
use WP_REST_Request;

/**
 * V2.4 Step 23. A customer's own saved-provider list — every route is
 * login-gated and scoped to the current user's own id (never a param),
 * same "ownership is implicit from the session, not a request field"
 * discipline as every other self-service resource in this codebase.
 */
final class WishlistController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/marketplace/wishlist',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'index' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);

		$this->route(
			'/marketplace/wishlist/(?P<provider_id>\d+)',
			[
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'add' ],
					'permission_callback' => [ $this, 'require_login' ],
					'args'                => [ 'provider_id' => [ 'type' => 'integer', 'required' => true ] ],
				],
				[
					'methods'             => 'DELETE',
					'callback'            => [ $this, 'remove' ],
					'permission_callback' => [ $this, 'require_login' ],
					'args'                => [ 'provider_id' => [ 'type' => 'integer', 'required' => true ] ],
				],
			]
		);
	}

	public function index(): \WP_REST_Response {
		$service      = new WishlistService();
		$provider_ids = $service->provider_ids_for( get_current_user_id() );

		return Response::ok( array_map( [ $this, 'format_provider' ], $provider_ids ) );
	}

	public function add( WP_REST_Request $request ): \WP_REST_Response {
		$provider_id = (int) $request->get_param( 'provider_id' );
		if ( ! $this->is_a_real_provider( $provider_id ) ) {
			return Response::error( 'bc_not_found', __( 'این پروفایل پیدا نشد.', 'beauclick-marketplace' ), 404 );
		}

		( new WishlistService() )->add( get_current_user_id(), $provider_id );

		return Response::ok( [ 'wishlisted' => true ] );
	}

	public function remove( WP_REST_Request $request ): \WP_REST_Response {
		$provider_id = (int) $request->get_param( 'provider_id' );
		( new WishlistService() )->remove( get_current_user_id(), $provider_id );

		return Response::ok( [ 'wishlisted' => false ] );
	}

	private function is_a_real_provider( int $provider_id ): bool {
		$post = get_post( $provider_id );
		return (bool) $post && in_array( $post->post_type, [ \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, \BeauClick\Marketplace\PostTypes\Registrar::BUSINESS ], true ) && 'publish' === $post->post_status;
	}

	/** @return array<string, mixed> */
	private function format_provider( int $provider_id ): array {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		$post = get_post( $provider_id );

		// A wishlisted provider whose own post/index row is gone (deleted,
		// unpublished) is still reported -- id + a null-ish shell -- rather
		// than silently vanishing from the customer's own saved list. The
		// frontend renders this as an honest "no longer available" state
		// instead of the item just disappearing without explanation.
		return [
			'id'        => $provider_id,
			'name'      => $post ? $post->post_title : null,
			'available' => (bool) ( $post && 'publish' === $post->post_status ),
			'cityId'    => $row && $row['city_id'] ? (int) $row['city_id'] : null,
			'priceFrom' => $row && null !== $row['price_from'] ? (int) $row['price_from'] : null,
			'rating'    => $row ? (float) $row['rating_avg'] : 0.0,
		];
	}
}
