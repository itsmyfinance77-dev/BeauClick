<?php
/**
 * Global helper, deliberately un-namespaced -- same reasoning as
 * beauclick-core's own beauclick_core() (see that file's own docblock).
 *
 * @package BeauClick\Auth
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_auth' ) ) {
	function beauclick_auth(): \BeauClick\Auth\Plugin {
		return \BeauClick\Auth\Plugin::instance();
	}
}
