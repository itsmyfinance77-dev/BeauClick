<?php
/**
 * Plugin Name: BeauClick Referral
 * Description: V2.2 Step 12 (Growth & Public Discovery — Referral half). Customer referral codes, attribution at registration, qualification on a referee's first completed booking/order, and reward through the existing loyalty ledger. No second points ledger, no second notification system, no second analytics engine.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-loyalty, beauclick-notifications
 * Author: BeauClick
 * Text Domain: beauclick-referral
 *
 * @package BeauClick\Referral
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_REFERRAL_VERSION', '0.1.0' );
define( 'BEAUCLICK_REFERRAL_DIR', __DIR__ );

$beauclick_referral_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_referral_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Referral: run "composer install" inside wp-content/plugins/beauclick-referral before activating this plugin.', 'beauclick-referral' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_referral_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Referral\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Referral\Plugin::class, 'deactivate' ] );

\BeauClick\Referral\Plugin::instance()->boot();
