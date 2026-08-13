<?php
/**
 * Plugin Name: BeauClick Analytics
 * Description: V2.2 Step 11 — Analytics & BI Foundation. Completes the event taxonomy (search, commerce funnel, UI-usage pings), then computes funnel/commerce/AI/retention/usage metrics live from wp_bc_events and existing domain tables (bookings, waitlist, notifications, orders). No second event-log system, no new database tables — see src/Plugin.php's docblock for why.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-analytics
 *
 * @package BeauClick\Analytics
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_ANALYTICS_VERSION', '0.1.0' );
define( 'BEAUCLICK_ANALYTICS_DIR', __DIR__ );

$beauclick_analytics_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_analytics_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Analytics: run "composer install" inside wp-content/plugins/beauclick-analytics before activating this plugin.', 'beauclick-analytics' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_analytics_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Analytics\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Analytics\Plugin::class, 'deactivate' ] );

\BeauClick\Analytics\Plugin::instance()->boot();
