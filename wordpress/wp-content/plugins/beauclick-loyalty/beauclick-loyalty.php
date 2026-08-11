<?php
/**
 * Plugin Name: BeauClick Loyalty
 * Description: Points ledger + award()/balance() seam. Stub only (architecture doc §13) — no point-awarding rules or account UI yet.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-loyalty
 *
 * @package BeauClick\Loyalty
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_LOYALTY_VERSION', '0.1.0' );
define( 'BEAUCLICK_LOYALTY_DIR', __DIR__ );

$beauclick_loyalty_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_loyalty_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Loyalty: run "composer install" inside wp-content/plugins/beauclick-loyalty before activating this plugin.', 'beauclick-loyalty' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_loyalty_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Loyalty\Plugin::class, 'activate' ] );

\BeauClick\Loyalty\Plugin::instance()->boot();
