<?php
declare( strict_types=1 );

namespace BeauClick\B2B;

use BeauClick\B2B\Database\Migrations\CreateB2BTables;
use BeauClick\B2B\Database\Seeds\DemoTierPricingSeed;
use BeauClick\B2B\Pricing\TierPricingEngine;
use BeauClick\B2B\Rest\B2BController;

final class Plugin {

	private const GROUP = 'beauclick-b2b';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		( new TierPricingEngine() )->register();

		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
		add_action( 'beauclick/seed', [ $this, 'maybe_seed' ] );
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateB2BTables() ] );
	}

	public function register_rest_routes(): void {
		( new B2BController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'b2b' ) {
			return;
		}
		DemoTierPricingSeed::run();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, [ new CreateB2BTables() ] );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
