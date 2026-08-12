<?php
declare( strict_types=1 );

namespace BeauClick\Core\Rest;

use WP_REST_Request;
use WP_Error;

/**
 * Base for every beauclick/v1 controller. Every route registered through
 * route() must declare a permission_callback — there is no "trusted by
 * default" endpoint in BeauClick; §20 of the architecture doc treats an
 * open permission_callback as a defect, not a shortcut.
 */
abstract class RestController {

	protected const NAMESPACE = 'beauclick/v1';

	abstract public function register_routes(): void;

	/**
	 * @param array<string, mixed> $args register_rest_route() args, minus namespace/route.
	 */
	protected function route( string $path, array $args ): void {
		foreach ( (array) ( $args[0] ?? $args ) as $variant ) {
			if ( isset( $variant['callback'] ) && ! isset( $variant['permission_callback'] ) ) {
				throw new \LogicException( sprintf( 'REST route "%s" is missing an explicit permission_callback.', $path ) );
			}
		}
		register_rest_route( self::NAMESPACE, $path, $args );
	}

	/**
	 * Public, not protected: these three are meant to be passed directly as
	 * `permission_callback => [ $this, 'require_login' ]` etc., and WP's REST
	 * dispatcher invokes permission_callback via call_user_func() from
	 * outside the class — a protected method there is a fatal TypeError,
	 * not a permission denial. Caught by booking's list_own route actually
	 * being hit over real HTTP, not by the isolated unit tests, which never
	 * go through the REST dispatcher's call_user_func().
	 */
	public function require_login(): bool|WP_Error {
		return is_user_logged_in() ? true : new WP_Error( 'bc_unauthorized', __( 'برای ادامه، ابتدا وارد حساب کاربری خود شوید.', 'beauclick-core' ), [ 'status' => 401 ] );
	}

	public function require_capability( string $capability ): bool|WP_Error {
		return current_user_can( $capability )
			? true
			: new WP_Error( 'bc_forbidden', __( 'شما اجازه انجام این کار را ندارید.', 'beauclick-core' ), [ 'status' => 403 ] );
	}

	/**
	 * Ownership check helper: the logged-in user must either own the resource
	 * (via the supplied $owner_user_id) or hold $override_capability (e.g. an
	 * admin/moderator capability). This is the pattern every "edit my own X"
	 * endpoint should use instead of a bare capability check, so a
	 * professional editing another professional's booking is rejected even
	 * though both share the bc_manage_own_services capability.
	 */
	public function require_owner_or_capability( int $owner_user_id, string $override_capability ): bool|WP_Error {
		$user_id = get_current_user_id();
		if ( $user_id && $user_id === $owner_user_id ) {
			return true;
		}
		return $this->require_capability( $override_capability );
	}

	protected function pagination_args( WP_REST_Request $request, int $default_per_page = 20, int $max_per_page = 100 ): array {
		$page     = max( 1, (int) $request->get_param( 'page' ) ?: 1 );
		$per_page = (int) $request->get_param( 'per_page' ) ?: $default_per_page;
		$per_page = max( 1, min( $max_per_page, $per_page ) );

		return [ $page, $per_page ];
	}
}
