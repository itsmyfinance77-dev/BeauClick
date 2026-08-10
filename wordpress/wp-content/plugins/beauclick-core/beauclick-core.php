<?php
/**
 * Plugin Name: BeauClick Core
 * Description: Shared kernel for the BeauClick platform — migration runner, roles/capabilities, REST base controller, service container, event log, design tokens. Every other beauclick-* plugin depends on this being active first.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Author: BeauClick
 * Text Domain: beauclick-core
 *
 * @package BeauClick\Core
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'BEAUCLICK_CORE_VERSION', '0.1.0' );
define( 'BEAUCLICK_CORE_FILE', __FILE__ );
define( 'BEAUCLICK_CORE_DIR', __DIR__ );

$beauclick_core_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_core_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Core: run "composer install" inside wp-content/plugins/beauclick-core before activating this plugin.', 'beauclick-core' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_core_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Core\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Core\Plugin::class, 'deactivate' ] );

\BeauClick\Core\Plugin::instance()->boot();
