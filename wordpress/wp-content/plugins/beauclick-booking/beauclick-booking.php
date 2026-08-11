<?php
/**
 * Plugin Name: BeauClick Booking
 * Description: Availability slots, atomic slot-locking, and the booking lifecycle (pending -> confirmed -> completed / cancelled / no_show / rescheduled).
 * Version: 0.1.0
 * Requires PHP: 8.2
 * Requires Plugins: beauclick-core, beauclick-marketplace
 * Author: BeauClick
 * Text Domain: beauclick-booking
 *
 * @package BeauClick\Booking
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_BOOKING_VERSION', '0.1.0' );
define( 'BEAUCLICK_BOOKING_DIR', __DIR__ );

$beauclick_booking_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! file_exists( $beauclick_booking_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>' .
				esc_html__( 'BeauClick Booking: run "composer install" inside wp-content/plugins/beauclick-booking before activating this plugin.', 'beauclick-booking' ) .
				'</p></div>';
		}
	);
	return;
}

require_once $beauclick_booking_autoload;

register_activation_hook( __FILE__, [ \BeauClick\Booking\Plugin::class, 'activate' ] );

\BeauClick\Booking\Plugin::instance()->boot();
