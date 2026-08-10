<?php
declare( strict_types=1 );

namespace BeauClick\Locations;

use BeauClick\Core\Database\Migrator;
use BeauClick\Locations\Database\Migrations\CreateLocationTables;
use BeauClick\Locations\Database\Seeds\IranLocationsSeed;
use BeauClick\Locations\Rest\LocationsController;

final class Plugin {

	private const GROUP = 'beauclick-locations';

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
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateLocationTables() ] );
	}

	public function register_rest_routes(): void {
		( new LocationsController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'locations' ) {
			return;
		}
		IranLocationsSeed::run();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			// beauclick-core must activate first; Requires Plugins header
			// (WP 6.5+) already prevents activation otherwise, this is a
			// defensive no-op if it's somehow bypassed.
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateLocationTables() ] );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
