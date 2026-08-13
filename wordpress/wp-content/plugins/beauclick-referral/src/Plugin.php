<?php
declare( strict_types=1 );

namespace BeauClick\Referral;

use BeauClick\Referral\Admin\ReferralAdminPage;
use BeauClick\Referral\Database\Migrations\CreateReferralTables;
use BeauClick\Referral\Listeners\AttributionListener;
use BeauClick\Referral\Listeners\QualificationListener;
use BeauClick\Referral\Rest\ReferralController;

final class Plugin {

	private const GROUP = 'beauclick-referral';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	private function migrations(): array {
		return [ new CreateReferralTables() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );

		( new AttributionListener() )->register();
		( new QualificationListener() )->register();
		( new ReferralAdminPage() )->register();
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new ReferralController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}

	public static function deactivate(): void {}
}
