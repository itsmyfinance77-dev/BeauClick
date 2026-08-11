<?php
/**
 * Plugin Name: BeauClick Marketplace
 * Description: Professional/business profiles, services, portfolio, specialty taxonomy, and the search-index table behind marketplace discovery.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-locations
 * Author: BeauClick
 * Text Domain: beauclick-marketplace
 *
 * @package BeauClick\Marketplace
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_MARKETPLACE_VERSION', '0.1.0' );
define( 'BEAUCLICK_MARKETPLACE_DIR', __DIR__ );

$beauclick_marketplace_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_marketplace_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Marketplace: run "composer install" inside wp-content/plugins/beauclick-marketplace before activating this plugin.', 'beauclick-marketplace' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_marketplace_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Marketplace\Plugin::class, 'activate' ] );

\BeauClick\Marketplace\Plugin::instance()->boot();
