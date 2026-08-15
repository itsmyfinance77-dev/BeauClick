<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns;

use BeauClick\Campaigns\Admin\CampaignAdminPage;
use BeauClick\Campaigns\Database\Migrations\CreateCampaignTables;
use BeauClick\Campaigns\Pricing\CampaignDiscount;
use BeauClick\Campaigns\Pricing\UsageReleaseListener;

final class Plugin {

	private const GROUP = 'beauclick-campaigns';

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	private function migrations(): array {
		return [ new CreateCampaignTables() ];
	}

	public function boot(): void {
		add_action( 'plugins_loaded', [ $this, 'register_migrations' ], 5 );

		/**
		 * Registered at priority 30 — deliberately after beauclick-payments'
		 * own order-creation callback (priority 10) and beauclick-loyalty's
		 * MembershipDiscount (priority 20), so a campaign discount is always
		 * computed against an order that already reflects Membership's own
		 * fee (if any) without ever needing to know Loyalty is active. See
		 * CampaignDiscount's own docblock for the full "no compounding"
		 * pricing-orchestration reasoning.
		 */
		( new CampaignDiscount() )->register();
		( new UsageReleaseListener() )->register();
		( new CampaignAdminPage() )->register();
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

	public static function deactivate(): void {}
}
