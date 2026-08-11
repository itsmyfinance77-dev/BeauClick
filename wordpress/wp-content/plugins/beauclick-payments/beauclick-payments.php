<?php
/**
 * Plugin Name: BeauClick Payments
 * Description: Bridges booking lifecycle <-> WooCommerce order lifecycle — a booking's payment is a real WooCommerce order, not a parallel payment system. No new payment abstraction: WooCommerce's gateway system already is one.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-booking, woocommerce
 * Author: BeauClick
 * Text Domain: beauclick-payments
 *
 * @package BeauClick\Payments
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_PAYMENTS_VERSION', '0.1.0' );
define( 'BEAUCLICK_PAYMENTS_DIR', __DIR__ );

$beauclick_payments_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_payments_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Payments: run "composer install" inside wp-content/plugins/beauclick-payments before activating this plugin.', 'beauclick-payments' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_payments_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Payments\Plugin::class, 'activate' ] );

\BeauClick\Payments\Plugin::instance()->boot();
