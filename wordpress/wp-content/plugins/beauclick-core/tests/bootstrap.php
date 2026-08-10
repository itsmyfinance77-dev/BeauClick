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
	// this, activation-only setup (the migration ledger table, custom roles)
	// silently never runs and every migration/role-dependent test fails on a
	// missing-table error that has nothing to do with the code under test.
	// Call each plugin's activation routine explicitly to simulate it.
	if ( class_exists( \BeauClick\Core\Plugin::class ) ) {
		\BeauClick\Core\Plugin::activate();
	}
}

tests_add_filter( 'muplugins_loaded', '_beauclick_manually_load_plugins' );

require "{$wp_tests_dir}/includes/bootstrap.php";
