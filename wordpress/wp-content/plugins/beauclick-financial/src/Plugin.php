<?php
declare( strict_types=1 );

namespace BeauClick\Financial;

use BeauClick\Financial\Admin\FinancialAdminPage;
use BeauClick\Financial\Database\Migrations\AddLedgerImmutabilityTriggers;
use BeauClick\Financial\Database\Migrations\CreateFinancialTables;
use BeauClick\Financial\Recording\PaymentRecorder;
use BeauClick\Financial\Recording\RefundRecorder;
use BeauClick\Financial\Rest\MyFinanceController;

final class Plugin {

	private const GROUP = 'beauclick-financial';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	private function migrations(): array {
		return [ new CreateFinancialTables(), new AddLedgerImmutabilityTriggers() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );

		( new PaymentRecorder() )->register();
		( new RefundRecorder() )->register();
		( new FinancialAdminPage() )->register();
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public function register_rest_routes(): void {
		( new MyFinanceController() )->register_routes();
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
