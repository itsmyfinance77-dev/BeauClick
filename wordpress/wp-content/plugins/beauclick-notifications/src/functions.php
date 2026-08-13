<?php
/**
 * Global helper, deliberately un-namespaced -- same reasoning as
 * beauclick-core's own beauclick_core() / beauclick-loyalty's
 * beauclick_loyalty(): PHP doesn't fall back to the global namespace for
 * unqualified function calls the way it does for classes.
 *
 * @package BeauClick\Notifications
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_notifications' ) ) {
	function beauclick_notifications(): \BeauClick\Notifications\NotificationService {
		return \BeauClick\Notifications\Plugin::instance()->service();
	}
}
