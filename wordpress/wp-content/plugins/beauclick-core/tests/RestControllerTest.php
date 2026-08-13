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
}
