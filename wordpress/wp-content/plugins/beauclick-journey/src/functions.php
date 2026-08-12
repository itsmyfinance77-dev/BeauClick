<?php
/**
 * Global helper, deliberately un-namespaced — same reasoning as
 * beauclick-core's own beauclick_core() (see that file's own docblock).
 *
 * @package BeauClick\Journey
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_journey' ) ) {
	function beauclick_journey(): \BeauClick\Journey\Plugin {
		return \BeauClick\Journey\Plugin::instance();
	}
}
