<?php
declare( strict_types=1 );

namespace BeauClick\Analytics;

use BeauClick\Analytics\Admin\AnalyticsDashboardPage;
use BeauClick\Analytics\Rest\AnalyticsController;
use BeauClick\Analytics\Tracking\CommerceTracker;

/**
 * V2.2 Step 11 — Analytics & BI Foundation.
 *
 * Deliberately registers no migrations and creates no new database tables.
 * Every metric this plugin computes (see Metrics\MetricsService) reads
 * from wp_bc_events (beauclick-core) and existing domain tables already
 * created by other plugins (wp_bc_bookings, wp_bc_waitlist_entries,
 * wp_bc_notifications, wp_users, wp_posts). The only write path this
 * plugin adds is: (a) three new WooCommerce-hook-driven events
 * (product_view/cart_add/checkout_started, via CommerceTracker) and (b) a
 * strictly allow-listed UI-visibility ping endpoint (POST /analytics/track)
 * — both write through the existing EventLogger into the existing
 * wp_bc_events table, never a second event-log mechanism.
 */
final class Plugin {

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	public function boot(): void {
		add_action( 'beauclick/core/register_rest_routes', [ $this, 'register_rest_routes' ] );

		( new CommerceTracker() )->register();
		( new AnalyticsDashboardPage() )->register();
	}

	public function register_rest_routes(): void {
		( new AnalyticsController() )->register_routes();
	}

	public static function activate(): void {
		// No migrations to run, no cron to schedule — see this class's own
		// docblock for why. Present for symmetry with every other
		// beauclick-* plugin's activation hook and as the natural place a
		// future migration/scheduler would be wired in if this plugin ever
		// needs one.
	}

	public static function deactivate(): void {}
}
