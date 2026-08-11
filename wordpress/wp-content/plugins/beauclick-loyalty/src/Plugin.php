<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty;

use BeauClick\Loyalty\Database\Migrations\AddLoyaltyReferenceUniqueIndex;
use BeauClick\Loyalty\Database\Migrations\CreateLoyaltyPointsTable;

final class Plugin {

	private const GROUP = 'beauclick-loyalty';

	private static ?Plugin $instance = null;

	private LoyaltyLedger $ledger;

	private function __construct() {
		$this->ledger = new LoyaltyLedger();
	}

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function migrations(): array {
		return [ new CreateLoyaltyPointsTable(), new AddLoyaltyReferenceUniqueIndex() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		( new EarningRules() )->register();
	}

	public function ledger(): LoyaltyLedger {
		return $this->ledger;
	}

	public function register_migrations(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, $this->migrations() );
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
