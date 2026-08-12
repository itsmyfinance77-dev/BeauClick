<?php
/**
 * Plugin Name: BeauClick Beauty Journey
 * Description: Customer beauty goals/preferences, a timeline composed from existing booking/review/order/AI event data, and authorized journey context for the AI assistant. V2.0 Step 4.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-marketplace, beauclick-booking, beauclick-loyalty
 * Author: BeauClick
 * Text Domain: beauclick-journey
 *
 * @package BeauClick\Journey
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_JOURNEY_VERSION', '0.1.0' );
define( 'BEAUCLICK_JOURNEY_DIR', __DIR__ );

$beauclick_journey_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_journey_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Journey: run "composer install" inside wp-content/plugins/beauclick-journey before activating this plugin.', 'beauclick-journey' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_journey_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Journey\Plugin::class, 'activate' ] );

\BeauClick\Journey\Plugin::instance()->boot();
