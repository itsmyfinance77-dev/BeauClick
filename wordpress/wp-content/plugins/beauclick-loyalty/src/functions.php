<?php
/**
 * Global helper, deliberately un-namespaced — same reasoning as
 * beauclick-core's own beauclick_core(): PHP doesn't fall back to the
 * global namespace for unqualified function calls the way it does for
 * classes, so declaring this inside `namespace BeauClick\Loyalty;` would
 * make it invisible to every other plugin's `function_exists()` check.
 *
 * @package BeauClick\Loyalty
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_loyalty' ) ) {
	function beauclick_loyalty(): \BeauClick\Loyalty\Plugin {
		return \BeauClick\Loyalty\Plugin::instance();
	}
}
