<?php
/**
 * Plugin Name: BeauClick Financial
 * Description: V2.3 Step 18 (Financial Ledger & Manual Settlement). A gateway-independent, auditable record of platform commission and professional/business receivables, computed from real, already-existing WooCommerce order/refund facts — never a second pricing engine, never automated payout. See docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md's "V2.3 Step 18" section.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-booking, beauclick-payments
 * Author: BeauClick
 * Text Domain: beauclick-financial
 *
 * @package BeauClick\Financial
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_FINANCIAL_VERSION', '0.1.0' );
define( 'BEAUCLICK_FINANCIAL_DIR', __DIR__ );

$beauclick_financial_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_financial_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Financial: run "composer install" inside wp-content/plugins/beauclick-financial before activating this plugin.', 'beauclick-financial' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_financial_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Financial\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Financial\Plugin::class, 'deactivate' ] );

\BeauClick\Financial\Plugin::instance()->boot();
