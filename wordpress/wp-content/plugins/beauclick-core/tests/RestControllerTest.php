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
}
