<?php
/**
 * Plugin Name: BeauClick AI Beauty Assistant
 * Description: Conversational recommendation surface — provider-agnostic (BC_AI_PROVIDER), server-side proxied, no vendor hardcoded into calling code (architecture doc §16).
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-ai
 *
 * @package BeauClick\AI
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_AI_VERSION', '0.1.0' );
define( 'BEAUCLICK_AI_DIR', __DIR__ );

$beauclick_ai_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_ai_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick AI: run "composer install" inside wp-content/plugins/beauclick-ai before activating this plugin.', 'beauclick-ai' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_ai_autoload;

register_activation_hook( __FILE__, [ \BeauClick\AI\Plugin::class, 'activate' ] );

\BeauClick\AI\Plugin::instance()->boot();
