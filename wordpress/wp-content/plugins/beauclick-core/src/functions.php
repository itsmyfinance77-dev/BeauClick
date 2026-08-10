<?php
/**
 * Global helper — deliberately in its own un-namespaced file. PHP falls
 * back to the global namespace for unqualified *class* names, but NOT for
 * unqualified function calls: a `beauclick_core()` call made from another
 * plugin's namespace (e.g. BeauClick\Locations) only resolves to a global
 * function if one is actually declared in the global namespace. Declaring
 * it inside src/Plugin.php (which starts with `namespace BeauClick\Core;`)
 * silently created BeauClick\Core\beauclick_core() instead — invisible to
 * every other plugin's `function_exists( 'beauclick_core' )` check. This
 * file, and beauclick-core.php requiring it directly, is the fix.
 *
 * @package BeauClick\Core
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_core' ) ) {
	function beauclick_core(): \BeauClick\Core\Plugin {
		return \BeauClick\Core\Plugin::instance();
	}
}
