<?php
/**
 * Plugin Name: BeauClick Locations
 * Description: Iran location architecture — Province > City > District/Neighborhood. Yazd is the launch city, never a hard-coded limit; the province/city list covers all of Iran from day one.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-locations
 *
 * @package BeauClick\Locations
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_LOCATIONS_VERSION', '0.1.0' );
define( 'BEAUCLICK_LOCATIONS_DIR', __DIR__ );

$beauclick_locations_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_locations_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Locations: run "composer install" inside wp-content/plugins/beauclick-locations before activating this plugin.', 'beauclick-locations' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_locations_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Locations\Plugin::class, 'activate' ] );

\BeauClick\Locations\Plugin::instance()->boot();
