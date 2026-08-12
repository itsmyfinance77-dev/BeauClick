<?php
/**
 * Plugin Name: BeauClick Authentication
 * Description: BeauClick-owned phone/OTP authentication and registration for customers, professionals, and businesses -- WordPress's own login remains the administrator path, untouched. V2.1 Step 6.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-auth
 *
 * @package BeauClick\Auth
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_AUTH_VERSION', '0.1.0' );
define( 'BEAUCLICK_AUTH_DIR', __DIR__ );

$beauclick_auth_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_auth_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Auth: run "composer install" inside wp-content/plugins/beauclick-auth before activating this plugin.', 'beauclick-auth' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_auth_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Auth\Plugin::class, 'activate' ] );

\BeauClick\Auth\Plugin::instance()->boot();
