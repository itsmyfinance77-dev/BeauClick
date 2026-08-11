<?php
declare( strict_types=1 );

namespace BeauClick\Booking;

use BeauClick\Booking\Database\Migrations\CreateBookingTables;
use BeauClick\Booking\Database\Seeds\DemoAvailabilitySeed;
use BeauClick\Booking\Rest\BookingController;

final class Plugin {

	private const GROUP = 'beauclick-booking';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
		add_action( 'beauclick/seed', [ $this, 'maybe_seed' ] );
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateBookingTables() ] );
	}

	public function register_rest_routes(): void {
		( new BookingController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'booking' ) {
			return;
		}
		DemoAvailabilitySeed::run();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateBookingTables() ] );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
