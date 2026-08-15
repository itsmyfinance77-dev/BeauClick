<?php
/**
 * PHPUnit bootstrap shared by every beauclick-* plugin's test suite (see
 * root phpunit.xml.dist). Loads the WordPress test scaffolding installed by
 * bin/install-wp-tests.sh, then every beauclick-* plugin so cross-plugin
 * integration tests (e.g. booking creating a WooCommerce order) work without
 * each plugin needing its own bootstrap.
 */

$wp_tests_dir = getenv( 'WP_TESTS_DIR' ) ?: '/tmp/wordpress-tests-lib';

if ( ! file_exists( "{$wp_tests_dir}/includes/functions.php" ) ) {
	fwrite( STDERR, "Could not find {$wp_tests_dir}/includes/functions.php — run bin/install-wp-tests.sh first.\n" );
	exit( 1 );
}

require_once "{$wp_tests_dir}/includes/functions.php";

function _beauclick_manually_load_plugins(): void {
	$plugins_dir = dirname( __DIR__, 2 ); // wp-content/plugins

	// WooCommerce must load before beauclick-* plugins (payments/booking
	// depend on it); it's expected as a sibling plugin dir in this
	// environment (installed the same way as in production, not vendored).
	$woocommerce = "{$plugins_dir}/woocommerce/woocommerce.php";
	if ( file_exists( $woocommerce ) ) {
		require $woocommerce;
	}

	foreach ( glob( "{$plugins_dir}/beauclick-*/beauclick-*.php" ) as $plugin_file ) {
		require $plugin_file;
	}

	// A plain require (above) loads each plugin's runtime hooks but does NOT
	// fire register_activation_hook() — that only happens via WP's real
	// activate_plugin() flow, which the test suite doesn't go through. Without
	// this, activation-only setup (the migration ledger table, custom roles,
	// each module's own tables) silently never runs and every migration/role
	// -dependent test fails on a missing-table error that has nothing to do
	// with the code under test. Call each plugin's activation routine
	// explicitly, in dependency order (core first) — an explicit list here
	// rather than deriving the class name from the directory name, since a
	// naming-convention mismatch (e.g. "ai" -> Ai vs AI) would silently skip
	// activation the same way the original bug did.
	$activation_order = [
		\BeauClick\Core\Plugin::class,
		\BeauClick\Locations\Plugin::class,
		\BeauClick\Marketplace\Plugin::class,
		\BeauClick\Booking\Plugin::class,
		\BeauClick\Payments\Plugin::class,
		\BeauClick\B2B\Plugin::class,
		\BeauClick\Chat\Plugin::class,
		\BeauClick\AI\Plugin::class,
		\BeauClick\Reviews\Plugin::class,
		\BeauClick\Loyalty\Plugin::class,
		\BeauClick\Campaigns\Plugin::class, // V2.3 Step 17 — depends on core/booking/payments (Requires Plugins), and hooks the same beauclick/booking/after_create filter Loyalty's MembershipDiscount does at a later priority; activation order relative to Loyalty doesn't matter for correctness, placed here for readability.
		\BeauClick\Financial\Plugin::class, // V2.3 Step 18 — depends on core/booking/payments (Requires Plugins); hooks the real woocommerce_payment_complete/woocommerce_order_refunded actions independently, no ordering dependency on Campaigns/Loyalty.
		\BeauClick\Journey\Plugin::class,
		\BeauClick\Auth\Plugin::class,
		\BeauClick\Notifications\Plugin::class,
		\BeauClick\Analytics\Plugin::class,
		\BeauClick\Referral\Plugin::class,
		\BeauClick\Privacy\Plugin::class, // V2.2 Step 14 — depends on core/auth/booking/journey/loyalty/notifications/referral/reviews/chat/ai, must activate last.
	];

	foreach ( $activation_order as $plugin_class ) {
		if ( class_exists( $plugin_class ) ) {
			$plugin_class::activate();
		}
	}
}

tests_add_filter( 'muplugins_loaded', '_beauclick_manually_load_plugins' );

require "{$wp_tests_dir}/includes/bootstrap.php";
