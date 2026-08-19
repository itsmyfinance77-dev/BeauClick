<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace;

use BeauClick\Marketplace\Admin\VerificationMetaBox;
use BeauClick\Marketplace\Admin\VerificationReviewPage;
use BeauClick\Marketplace\Database\Migrations\AddProviderRankingSignalsColumn;
use BeauClick\Marketplace\Database\Migrations\AddProviderSearchTextColumn;
use BeauClick\Marketplace\Database\Migrations\CreateBusinessStaffTable;
use BeauClick\Marketplace\Database\Migrations\CreateProviderIndexTable;
use BeauClick\Marketplace\Database\Migrations\CreateVerificationTables;
use BeauClick\Marketplace\Database\Migrations\CreateWishlistTable;
use BeauClick\Marketplace\Database\Seeds\DemoProvidersSeed;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\MarketplaceController;
use BeauClick\Marketplace\Rest\MyProfileController;
use BeauClick\Marketplace\Rest\PortfolioController;
use BeauClick\Marketplace\Rest\StaffController;
use BeauClick\Marketplace\Rest\VerificationController;
use BeauClick\Marketplace\Rest\WishlistController;
use BeauClick\Marketplace\Search\Indexer;

final class Plugin {

	private const GROUP = 'beauclick-marketplace';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		( new Registrar() )->register();
		( new Indexer() )->register();
		( new VerificationMetaBox() )->register();
		( new VerificationReviewPage() )->register();

		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
		add_action( 'beauclick/seed', [ $this, 'maybe_seed' ] );
	}

	private function migrations(): array {
		return [ new CreateProviderIndexTable(), new AddProviderRankingSignalsColumn(), new CreateVerificationTables(), new CreateBusinessStaffTable(), new AddProviderSearchTextColumn(), new CreateWishlistTable() ];
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new MarketplaceController() )->register_routes();
		( new MyProfileController() )->register_routes();
		( new PortfolioController() )->register_routes();
		( new VerificationController() )->register_routes();
		( new StaffController() )->register_routes();
		( new WishlistController() )->register_routes();
	}

	public function maybe_seed( ?string $only ): void {
		if ( $only !== null && $only !== 'marketplace' ) {
			return;
		}
		DemoProvidersSeed::run();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
