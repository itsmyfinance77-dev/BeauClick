<?php
/**
 * Plugin Name: BeauClick Campaigns
 * Description: V2.3 Step 17 (Pricing Orchestration + Campaign Engine, Phase 1). Admin-authored promotional discounts applied as an itemized order-level fee on booking orders only — never the WooCommerce cart, never WooCommerce's own (unused) coupon system. See docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md's "V2.3 Step 17" section for the full architecture and the Pricing Orchestration decision this plugin implements.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-booking, beauclick-payments
 * Author: BeauClick
 * Text Domain: beauclick-campaigns
 *
 * @package BeauClick\Campaigns
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_CAMPAIGNS_VERSION', '0.1.0' );
define( 'BEAUCLICK_CAMPAIGNS_DIR', __DIR__ );

$beauclick_campaigns_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_campaigns_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Campaigns: run "composer install" inside wp-content/plugins/beauclick-campaigns before activating this plugin.', 'beauclick-campaigns' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_campaigns_autoload;
require_once __DIR__ . '/src/functions.php';

register_activation_hook( __FILE__, [ \BeauClick\Campaigns\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Campaigns\Plugin::class, 'deactivate' ] );

\BeauClick\Campaigns\Plugin::instance()->boot();
