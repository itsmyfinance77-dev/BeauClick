<?php
/**
 * Plugin Name: BeauClick B2B
 * Description: Business accounts, tiered wholesale pricing, MOQ, and quotes — built on WooCommerce's own pricing/order machinery, not a parallel system.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, woocommerce
 * Author: BeauClick
 * Text Domain: beauclick-b2b
 *
 * @package BeauClick\B2B
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_B2B_VERSION', '0.1.0' );
define( 'BEAUCLICK_B2B_DIR', __DIR__ );

$beauclick_b2b_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_b2b_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick B2B: run "composer install" inside wp-content/plugins/beauclick-b2b before activating this plugin.', 'beauclick-b2b' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_b2b_autoload;

register_activation_hook( __FILE__, [ \BeauClick\B2B\Plugin::class, 'activate' ] );

\BeauClick\B2B\Plugin::instance()->boot();
