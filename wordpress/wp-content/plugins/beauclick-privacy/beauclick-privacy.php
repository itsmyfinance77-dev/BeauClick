<?php
/**
 * Plugin Name: BeauClick Privacy
 * Description: V2.2 Step 14 (Account Privacy & Data Control). Self-service customer data export and admin-reviewed account deletion/anonymization, orchestrated across every domain that holds customer data — never a second copy of any of it.
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-auth, beauclick-booking, beauclick-journey, beauclick-loyalty, beauclick-notifications, beauclick-referral, beauclick-reviews, beauclick-chat, beauclick-ai
 * Author: BeauClick
 * Text Domain: beauclick-privacy
 *
 * @package BeauClick\Privacy
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_PRIVACY_VERSION', '0.1.0' );
define( 'BEAUCLICK_PRIVACY_DIR', __DIR__ );
define( 'BEAUCLICK_PRIVACY_FILE', __FILE__ );

$beauclick_privacy_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_privacy_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Privacy: run "composer install" inside wp-content/plugins/beauclick-privacy before activating this plugin.', 'beauclick-privacy' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_privacy_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Privacy\Plugin::class, 'activate' ] );
register_deactivation_hook( __FILE__, [ \BeauClick\Privacy\Plugin::class, 'deactivate' ] );

\BeauClick\Privacy\Plugin::instance()->boot();
