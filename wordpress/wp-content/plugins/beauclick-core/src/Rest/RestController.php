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
	 * @param array<string, mixed> $args register_rest_route() args, minus
	 *        namespace/route, plus two BeauClick-only keys stripped before
	 *        being handed to register_rest_route() (which ignores unknown
	 *        keys anyway, but stripping keeps the args WP itself receives
	 *        exactly what every other route already passes):
	 *        - 'adminGated' (bool): declares this route as a
	 *          bc_manage_platform-class administrative mutation.
	 *        - 'auditAction' (string) or 'auditExempt' (string): required
	 *          together with 'adminGated' — either the action_type string
	 *          this route's handler calls AuditLogger::record() with, or a
	 *          short, real reason it deliberately doesn't (e.g. "read-only").
	 */
	protected function route( string $path, array $args ): void {
		// register_rest_route() accepts either one flat args array (the
		// shape every controller in this codebase actually uses) or an
		// array of several such variant arrays (one per HTTP method). A
		// flat array is distinguished from a list-of-variants by having its
		// own 'callback' key directly on $args, not on $args[0].
		$variants = isset( $args['callback'] ) ? [ $args ] : $args;
		foreach ( $variants as $variant ) {
			if ( is_array( $variant ) && isset( $variant['callback'] ) && ! isset( $variant['permission_callback'] ) ) {
				throw new \LogicException( sprintf( 'REST route "%s" is missing an explicit permission_callback.', $path ) );
			}
			// V2.4 Step 26 (GAP-02): the identical structural-enforcement
			// shape the permission_callback guard above already uses,
			// applied to audit logging — the specific recurring bug class
			// found and fixed three separate times across two plugins (B2B
			// account approve/reject, B2B quote pricing, Loyalty tier/plan/
			// benefit CRUD): a REST-reachable, capability-gated admin
			// mutation silently skipping the audit call its wp-admin twin
			// already makes. A route marked 'adminGated' must now declare
			// how it satisfies the audit trail at registration time — it
			// cannot simply be forgotten the way the bug recurred before.
			if ( is_array( $variant ) && ! empty( $variant['adminGated'] ) && ! isset( $variant['auditAction'] ) && ! isset( $variant['auditExempt'] ) ) {
				throw new \LogicException( sprintf( 'REST route "%s" is adminGated but declares neither auditAction nor auditExempt.', $path ) );
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
	 * (via the supplied $resource_owner_id) or hold $override_capability
	 * (e.g. an admin/moderator capability). This is the pattern every "edit
	 * my own X" endpoint should use instead of a bare capability check, so a
	 * professional editing another professional's booking is rejected even
	 * though both share the bc_manage_own_services capability.
	 *
	 * V2.4 Step 26 (GAP-08): $owner_resolver fixes the real, confirmed gap —
	 * most ownership in this codebase is INDIRECT (a booking is owned by a
	 * provider, which is owned by a user; not "a booking is owned by a user"
	 * directly), which this method previously couldn't express, forcing
	 * every indirect-ownership domain (BookingController::can_confirm()/
	 * can_manage_booking() are the confirmed real example) to reimplement
	 * its own inline ownership gate instead of using this shared one.
	 * Omitting it (the default) preserves the exact previous behavior and
	 * every existing direct-ownership call site (WaitlistController,
	 * JourneyController, MyProfileController, ReceiptController) needs no
	 * change.
	 *
	 * @param callable(int $currentUserId): (int|null) $owner_resolver
	 *        Resolves the CURRENT user's own identity in whatever space
	 *        $resource_owner_id is expressed — e.g. their own provider post
	 *        id via ProviderLookup::for_user(), not their raw WP user id.
	 *        Return null when the current user has no such identity at all
	 *        (e.g. they're not a professional).
	 */
	public function require_owner_or_capability( int $resource_owner_id, string $override_capability, ?callable $owner_resolver = null ): bool|WP_Error {
		$user_id = get_current_user_id();
		if ( $user_id ) {
			$my_id = null !== $owner_resolver ? $owner_resolver( $user_id ) : $user_id;
			if ( null !== $my_id && $my_id === $resource_owner_id ) {
				return true;
			}
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
