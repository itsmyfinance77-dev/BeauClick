<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty;

use BeauClick\Loyalty\Admin\LoyaltyAdminPage;
use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\Database\Migrations\AddLoyaltyReferenceUniqueIndex;
use BeauClick\Loyalty\Database\Migrations\CreateLoyaltyPointsTable;
use BeauClick\Loyalty\Database\Migrations\CreateTierMembershipTables;
use BeauClick\Loyalty\Membership\MembershipExpiryScheduler;
use BeauClick\Loyalty\Rest\LoyaltyController;

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
		return [ new CreateLoyaltyPointsTable(), new AddLoyaltyReferenceUniqueIndex(), new CreateTierMembershipTables() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );
		( new EarningRules() )->register();
		( new Pricing\MembershipDiscount() )->register();
		( new Membership\TierMembershipSync() )->register();
		add_filter(
			'beauclick/loyalty/points_multiplier',
			static fn ( float $multiplier, int $user_id ) => max( $multiplier, ( new BenefitService() )->points_multiplier_for_user( $user_id ) ),
			10,
			2
		);

		$expiry_scheduler = new MembershipExpiryScheduler();
		$expiry_scheduler->register();
		add_action( 'admin_init', [ $expiry_scheduler, 'ensure_scheduled' ] );

		( new LoyaltyAdminPage() )->register();

		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );
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

	public function register_rest_routes(): void {
		( new LoyaltyController() )->register_routes();
	}

	public static function activate(): void {
		if ( ! function_exists( 'beauclick_core' ) ) {
			return;
		}
		beauclick_core()->migrator()->register( self::GROUP, self::instance()->migrations() );
		beauclick_core()->migrator()->run_group( self::GROUP );
	}
}
