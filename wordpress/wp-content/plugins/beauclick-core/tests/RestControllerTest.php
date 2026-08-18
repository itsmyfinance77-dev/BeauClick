<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Rest\RestController;
use WP_UnitTestCase;

/**
 * Regression test: require_login()/require_capability()/
 * require_owner_or_capability() must be callable via call_user_func() from
 * OUTSIDE the class, exactly how WP_REST_Server invokes a
 * `permission_callback => [ $this, 'require_login' ]` value. A `protected`
 * method passes phpcs/php -l fine and only fails at the moment a real HTTP
 * request hits the route — which is exactly how this shipped once already
 * (beauclick-booking's list_own route, caught by live verification, not by
 * the unit tests, since tests call the controller's own methods directly
 * and never go through WP_REST_Server::dispatch()).
 */
final class RestControllerTest extends WP_UnitTestCase {

	public function test_permission_helpers_are_callable_from_outside_the_class(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
		};

		foreach ( [ 'require_login', 'require_capability', 'require_owner_or_capability' ] as $method ) {
			$this->assertIsCallable(
				[ $controller, $method ],
				"{$method}() must be public — WP_REST_Server calls permission_callback via call_user_func() from outside the controller class."
			);
		}
	}

	/**
	 * Regression test for a real, confirmed bug found during the V2.1 final
	 * release audit: route()'s missing-permission_callback guard iterated
	 * `$args[0] ?? $args`, which for the flat single-variant array shape
	 * every controller in this codebase actually uses (e.g.
	 * `['methods'=>'POST','callback'=>...,'permission_callback'=>...]`)
	 * falls through to `$args` itself and then iterates over each of ITS
	 * top-level *values* (the string 'POST', the callback array, the
	 * permission_callback array) rather than over route-variant arrays —
	 * `isset($variant['callback'])` was never true for any of those, so the
	 * guard never actually threw, for any route, ever. Every real route
	 * already happened to declare permission_callback, so this was a dead
	 * safety net, not a live hole — but SEC-03 in the gap register claims
	 * this exact mechanism as the structural enforcement, so it needed to
	 * actually work.
	 */
	public function test_route_throws_when_the_flat_single_variant_shape_omits_permission_callback(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		$this->expectException( \LogicException::class );
		$controller->call_route( '/test/missing-permission', [ 'methods' => 'POST', 'callback' => '__return_true' ] );
	}

	public function test_route_does_not_throw_when_the_flat_single_variant_shape_has_permission_callback(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		// register_rest_route() itself (called after the guard passes)
		// legitimately warns when invoked outside rest_api_init -- expected
		// and irrelevant to what this test is verifying (the guard logic).
		$this->setExpectedIncorrectUsage( 'register_rest_route' );
		$controller->call_route( '/test/has-permission', [ 'methods' => 'POST', 'callback' => '__return_true', 'permission_callback' => '__return_true' ] );
		$this->assertTrue( true, 'route() must not throw when permission_callback is present on the flat args shape.' );
	}

	/**
	 * V2.4 Step 26 (GAP-02): the same structural-enforcement shape as the
	 * permission_callback guard above, applied to audit logging — a route
	 * marked adminGated must declare how it satisfies the audit trail, or
	 * registration itself fails loudly instead of silently shipping a
	 * capability-gated admin mutation with no audit record.
	 */
	public function test_route_throws_when_admin_gated_declares_neither_audit_action_nor_exempt(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		$this->expectException( \LogicException::class );
		$controller->call_route(
			'/test/admin-mutation-missing-audit',
			[ 'methods' => 'POST', 'callback' => '__return_true', 'permission_callback' => '__return_true', 'adminGated' => true ]
		);
	}

	public function test_route_does_not_throw_when_admin_gated_declares_an_audit_action(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		$this->setExpectedIncorrectUsage( 'register_rest_route' );
		$controller->call_route(
			'/test/admin-mutation-with-audit',
			[ 'methods' => 'POST', 'callback' => '__return_true', 'permission_callback' => '__return_true', 'adminGated' => true, 'auditAction' => 'test_action' ]
		);
		$this->assertTrue( true, 'route() must not throw when an adminGated route declares a real auditAction.' );
	}

	public function test_route_does_not_throw_when_admin_gated_declares_an_explicit_exemption(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		$this->setExpectedIncorrectUsage( 'register_rest_route' );
		$controller->call_route(
			'/test/admin-mutation-exempt',
			[ 'methods' => 'POST', 'callback' => '__return_true', 'permission_callback' => '__return_true', 'adminGated' => true, 'auditExempt' => 'read-only, no state change' ]
		);
		$this->assertTrue( true, 'route() must not throw when an adminGated route declares a real, reasoned auditExempt.' );
	}

	public function test_route_does_not_throw_for_a_non_admin_gated_route_with_neither_key(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
			public function call_route( string $path, array $args ): void {
				( new \ReflectionMethod( RestController::class, 'route' ) )->invoke( $this, $path, $args );
			}
		};

		// The overwhelming majority of routes in this codebase are not
		// admin-gated mutations at all (customer bookings, public browse,
		// etc.) -- this enforcement must never retroactively demand
		// declarations from routes that were never part of the bug class it
		// targets.
		$this->setExpectedIncorrectUsage( 'register_rest_route' );
		$controller->call_route(
			'/test/ordinary-route',
			[ 'methods' => 'GET', 'callback' => '__return_true', 'permission_callback' => '__return_true' ]
		);
		$this->assertTrue( true, 'route() must not require audit declarations from routes that never opted into adminGated.' );
	}

	/**
	 * V2.4 Step 26 (GAP-08): require_owner_or_capability()'s pre-existing
	 * direct-ownership behavior (no resolver) must be completely unchanged —
	 * every real call site (WaitlistController, JourneyController,
	 * MyProfileController, ReceiptController) relies on this exact shape and
	 * was not touched by this fix.
	 */
	public function test_direct_ownership_still_works_without_a_resolver(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
		};
		$owner_id = self::factory()->user->create();
		wp_set_current_user( $owner_id );

		$this->assertTrue( $controller->require_owner_or_capability( $owner_id, 'bc_manage_platform' ) );
	}

	public function test_direct_ownership_falls_back_to_capability_when_the_current_user_is_not_the_owner(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
		};
		$owner_id     = self::factory()->user->create();
		$other_id     = self::factory()->user->create();
		wp_set_current_user( $other_id );

		$result = $controller->require_owner_or_capability( $owner_id, 'bc_manage_platform' );

		$this->assertInstanceOf( \WP_Error::class, $result, 'A non-owner without bc_manage_platform must be rejected, not silently allowed.' );
	}

	/**
	 * The real, confirmed gap: ownership expressed in a DIFFERENT id space
	 * than the raw WP user id (e.g. a booking's provider_id, which is a CPT
	 * post id, not the professional's own user id) — previously
	 * unsupported, forcing every such domain to reimplement this check
	 * inline (BookingController::can_confirm() was the confirmed real
	 * example, fixed in this same step to use this resolver instead of its
	 * own copy of this logic).
	 */
	public function test_indirect_ownership_succeeds_via_a_resolver(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
		};
		$user_id           = self::factory()->user->create();
		$resource_owner_id = 999; // e.g. a provider post id, unrelated to $user_id's own numeric value.
		wp_set_current_user( $user_id );

		$result = $controller->require_owner_or_capability(
			$resource_owner_id,
			'bc_manage_platform',
			static fn ( int $current_user_id ): ?int => $current_user_id === $user_id ? 999 : null
		);

		$this->assertTrue( $result, 'A resolver mapping the current user to the resource\'s own owner-id space must be allowed through.' );
	}

	public function test_indirect_ownership_falls_back_to_capability_when_the_resolver_returns_null(): void {
		$controller = new class() extends RestController {
			public function register_routes(): void {}
		};
		$user_id = self::factory()->user->create(); // has no bc_manage_platform capability
		wp_set_current_user( $user_id );

		// A resolver returning null models "this user has no identity in the
		// resource's owner-id space at all" (e.g. not a professional) --
		// must fall through to the capability check, never be treated as a
		// match against any resource_owner_id.
		$result = $controller->require_owner_or_capability(
			999,
			'bc_manage_platform',
			static fn ( int $current_user_id ): ?int => null
		);

		$this->assertInstanceOf( \WP_Error::class, $result );
	}
}
