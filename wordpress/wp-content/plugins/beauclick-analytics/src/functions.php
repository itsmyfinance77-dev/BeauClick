<?php
/**
 * Global helper, deliberately un-namespaced -- same reasoning as
 * beauclick-core's own beauclick_core() / beauclick-notifications'
 * beauclick_notifications(): PHP doesn't fall back to the global namespace
 * for unqualified function calls the way it does for classes.
 *
 * @package BeauClick\Analytics
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_analytics' ) ) {
	function beauclick_analytics(): \BeauClick\Analytics\Metrics\MetricsService {
		return new \BeauClick\Analytics\Metrics\MetricsService();
	}
}
