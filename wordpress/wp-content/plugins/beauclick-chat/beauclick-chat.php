<?php
/**
 * Plugin Name: BeauClick Chat
 * Description: Conversations and messages between customers and professionals/businesses — custom tables + REST + client polling (architecture doc §15).
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core
 * Author: BeauClick
 * Text Domain: beauclick-chat
 *
 * @package BeauClick\Chat
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_CHAT_VERSION', '0.1.0' );
define( 'BEAUCLICK_CHAT_DIR', __DIR__ );

$beauclick_chat_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_chat_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Chat: run "composer install" inside wp-content/plugins/beauclick-chat before activating this plugin.', 'beauclick-chat' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_chat_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Chat\Plugin::class, 'activate' ] );

\BeauClick\Chat\Plugin::instance()->boot();
