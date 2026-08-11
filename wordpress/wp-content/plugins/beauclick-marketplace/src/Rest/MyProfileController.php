<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;
use WP_REST_Request;

/**
 * Self-service for a professional/business managing their own profile and
 * services — every write here is ownership-checked against post_author,
 * never just "has the manage-services capability" (that capability is
 * shared by every professional; owning the specific post is what actually
 * authorizes editing it — architecture doc §20).
 */
final class MyProfileController extends RestController {

	public function register_routes(): void {
		$this->route( '/marketplace/my/profile', [ 'methods' => 'GET', 'callback' => [ $this, 'get_profile' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/marketplace/my/profile',
			[
				'methods'             => 'PATCH',
				'callback'            => [ $this, 'update_profile' ],
				'permission_callback' => [ $this, 'require_login' ],
			]
		);

		$this->route( '/marketplace/my/services', [ 'methods' => 'GET', 'callback' => [ $this, 'list_services' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/marketplace/my/services',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'create_service' ],
				'permission_callback' => [ $this, 'can_manage_own_services' ],
				'args'                => [ 'name' => [ 'type' => 'string', 'required' => true ] ],
			]
		);
		$this->route(
			'/marketplace/my/services/(?P<id>\d+)',
			[
				[ 'methods' => 'PATCH', 'callback' => [ $this, 'update_service' ], 'permission_callback' => [ $this, 'can_edit_service' ] ],
				[ 'methods' => 'DELETE', 'callback' => [ $this, 'delete_service' ], 'permission_callback' => [ $this, 'can_edit_service' ] ],
			]
		);
	}

	/**
	 * A dedicated method rather than passing [$this, 'require_capability']
	 * (the base class's own helper) directly as a permission_callback: WP's
	 * REST dispatcher calls permission_callback with the WP_REST_Request as
	 * its argument, which would land in require_capability()'s
	 * `string $capability` parameter and TypeError immediately — the exact
	 * same "callback signature must match how WP_REST_Server actually
	 * invokes it" class of bug as the require_login() visibility fix
	 * earlier this project, this time a parameter-type mismatch instead of
	 * a visibility one.
	 */
	public function can_manage_own_services(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_own_services' );
	}

	private function my_provider_post(): ?\WP_Post {
		$user_id = get_current_user_id();
		$posts   = get_posts(
			[
				'post_type'      => [ Registrar::PROFESSIONAL, Registrar::BUSINESS ],
				'author'         => $user_id,
				'post_status'    => 'any',
				'posts_per_page' => 1,
			]
		);
		return $posts[0] ?? null;
	}

	public function can_edit_service( WP_REST_Request $request ): bool|\WP_Error {
		$service = get_post( (int) $request->get_param( 'id' ) );
		if ( ! $service || Registrar::SERVICE !== $service->post_type ) {
			return true; // Let the handler 404 — permission isn't the interesting failure.
		}
		return $this->require_owner_or_capability( (int) $service->post_author, 'bc_manage_platform' );
	}

	public function get_profile(): \WP_REST_Response {
		$provider = $this->my_provider_post();
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص ندارید.', 'beauclick-marketplace' ), 404 );
		}

		return Response::ok(
			[
				'id'         => $provider->ID,
				'name'       => $provider->post_title,
				'bio'        => $provider->post_content,
				'status'     => $provider->post_status,
				'cityId'     => (int) get_post_meta( $provider->ID, '_bc_city_id', true ) ?: null,
				'districtId' => (int) get_post_meta( $provider->ID, '_bc_district_id', true ) ?: null,
				'verified'   => 'verified' === get_post_meta( $provider->ID, '_bc_verification_status', true ),
			]
		);
	}

	public function update_profile( WP_REST_Request $request ): \WP_REST_Response {
		$provider = $this->my_provider_post();
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'شما هنوز پروفایل متخصص ندارید.', 'beauclick-marketplace' ), 404 );
		}

		$update = [ 'ID' => $provider->ID ];
		if ( null !== $request->get_param( 'name' ) ) {
			$update['post_title'] = sanitize_text_field( (string) $request->get_param( 'name' ) );
		}
		if ( null !== $request->get_param( 'bio' ) ) {
			$update['post_content'] = wp_kses_post( (string) $request->get_param( 'bio' ) );
		}
		wp_update_post( $update );

		if ( null !== $request->get_param( 'city_id' ) ) {
			update_post_meta( $provider->ID, '_bc_city_id', (int) $request->get_param( 'city_id' ) );
		}
		if ( null !== $request->get_param( 'district_id' ) ) {
			update_post_meta( $provider->ID, '_bc_district_id', (int) $request->get_param( 'district_id' ) );
		}

		( new Indexer() )->sync( $provider->ID, $provider->post_type );

		return Response::ok( [ 'updated' => true ] );
	}

	public function list_services(): \WP_REST_Response {
		$provider = $this->my_provider_post();
		if ( ! $provider ) {
			return Response::ok( [] );
		}

		$services = get_posts(
			[
				'post_type'      => Registrar::SERVICE,
				'post_parent'    => $provider->ID,
				'post_status'    => 'any',
				'posts_per_page' => -1,
			]
		);

		return Response::ok( array_map( [ $this, 'format_service' ], $services ) );
	}

	public function create_service( WP_REST_Request $request ): \WP_REST_Response {
		$provider = $this->my_provider_post();
		if ( ! $provider ) {
			return Response::error( 'bc_no_profile', __( 'برای افزودن خدمت ابتدا باید پروفایل متخصص داشته باشید.', 'beauclick-marketplace' ), 404 );
		}

		$service_id = wp_insert_post(
			[
				'post_type'   => Registrar::SERVICE,
				'post_title'  => sanitize_text_field( (string) $request->get_param( 'name' ) ),
				'post_status' => 'publish',
				'post_author' => get_current_user_id(),
				'post_parent' => $provider->ID,
			]
		);

		if ( is_wp_error( $service_id ) ) {
			return Response::error( 'bc_create_failed', __( 'ایجاد خدمت ناموفق بود.', 'beauclick-marketplace' ), 500 );
		}

		update_post_meta( $service_id, '_bc_duration_minutes', (int) $request->get_param( 'duration_minutes' ) );
		update_post_meta( $service_id, '_bc_price', (int) $request->get_param( 'price' ) );

		return Response::ok( [ 'id' => $service_id ], [], 201 );
	}

	public function update_service( WP_REST_Request $request ): \WP_REST_Response {
		$service_id = (int) $request->get_param( 'id' );

		$update = [ 'ID' => $service_id ];
		if ( null !== $request->get_param( 'name' ) ) {
			$update['post_title'] = sanitize_text_field( (string) $request->get_param( 'name' ) );
		}
		if ( count( $update ) > 1 ) {
			wp_update_post( $update );
		}
		if ( null !== $request->get_param( 'duration_minutes' ) ) {
			update_post_meta( $service_id, '_bc_duration_minutes', (int) $request->get_param( 'duration_minutes' ) );
		}
		if ( null !== $request->get_param( 'price' ) ) {
			update_post_meta( $service_id, '_bc_price', (int) $request->get_param( 'price' ) );
		}

		$service = get_post( $service_id );
		if ( $service && $service->post_parent ) {
			$parent = get_post( $service->post_parent );
			( new Indexer() )->sync( $parent->ID, $parent->post_type ); // Price change may affect the parent's price_from.
		}

		return Response::ok( [ 'updated' => true ] );
	}

	public function delete_service( WP_REST_Request $request ): \WP_REST_Response {
		wp_trash_post( (int) $request->get_param( 'id' ) );
		return Response::ok( [ 'deleted' => true ] );
	}

	private function format_service( \WP_Post $service ): array {
		return [
			'id'              => $service->ID,
			'name'            => $service->post_title,
			'status'          => $service->post_status,
			'durationMinutes' => (int) get_post_meta( $service->ID, '_bc_duration_minutes', true ),
			'price'           => (int) get_post_meta( $service->ID, '_bc_price', true ),
		];
	}
}
