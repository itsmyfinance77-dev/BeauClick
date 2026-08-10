<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use WP_UnitTestCase;

/**
 * Regression test for a real bug found while activating beauclick-locations:
 * beauclick_core() must be a truly global function, callable unqualified
 * from any other plugin's namespace — PHP only falls back to the global
 * namespace for unqualified *class* names, not function calls, so
 * declaring the helper inside `namespace BeauClick\Core;` without an
 * explicit global-namespace block made it invisible to every other plugin.
 */
final class GlobalHelperTest extends WP_UnitTestCase {

	public function test_beauclick_core_helper_is_globally_callable(): void {
		$this->assertTrue(
			function_exists( 'beauclick_core' ),
			'beauclick_core() must exist in the global namespace so `function_exists(\'beauclick_core\')` checks from other plugins (e.g. beauclick-locations\' Plugin::activate()) succeed.'
		);
	}

	public function test_beauclick_core_helper_returns_the_singleton(): void {
		$this->assertInstanceOf( \BeauClick\Core\Plugin::class, \beauclick_core() );
		$this->assertSame( \beauclick_core(), \beauclick_core(), 'Must return the same singleton instance every call.' );
	}
}
