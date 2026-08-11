<?php
/**
 * Plugin Name: BeauClick Reviews
 * Description: Booking-verified provider reviews — a review may only be written against a booking the author owns that has actually completed (architecture doc §8).
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-marketplace, beauclick-booking
 * Author: BeauClick
 * Text Domain: beauclick-reviews
 *
 * @package BeauClick\Reviews
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_REVIEWS_VERSION', '0.1.0' );
define( 'BEAUCLICK_REVIEWS_DIR', __DIR__ );

$beauclick_reviews_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_reviews_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Reviews: run "composer install" inside wp-content/plugins/beauclick-reviews before activating this plugin.', 'beauclick-reviews' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_reviews_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Reviews\Plugin::class, 'activate' ] );

\BeauClick\Reviews\Plugin::instance()->boot();
