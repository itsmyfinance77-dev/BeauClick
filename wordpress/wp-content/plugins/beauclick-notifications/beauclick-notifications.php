<?php
/**
 * Plugin Name: BeauClick Notifications
 * Description: Central notification service (event -> template -> recipient -> channel -> delivery) reused by Waitlist, Reminders, Rebooking, and Retention automation. Reuses beauclick-auth's SMS abstraction and wp_mail() -- no second delivery system.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-notifications
 *
 * @package BeauClick\Notifications
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_NOTIFICATIONS_VERSION', '0.1.0' );
define( 'BEAUCLICK_NOTIFICATIONS_DIR', __DIR__ );

$beauclick_notifications_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_notifications_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Notifications: run "composer install" inside wp-content/plugins/beauclick-notifications before activating this plugin.', 'beauclick-notifications' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_notifications_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Notifications\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Notifications\Plugin::class, 'deactivate' ] );

\BeauClick\Notifications\Plugin::instance()->boot();
