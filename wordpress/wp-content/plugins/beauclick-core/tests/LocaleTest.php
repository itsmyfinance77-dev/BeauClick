<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Plugin;
use WP_UnitTestCase;

/**
 * A production-readiness audit found the checkout page's own labels
 * ("Place order", "Billing details", the country dropdown) were all in
 * English — every hand-authored BeauClick string was correctly Persian,
 * but WordPress/WooCommerce's own translated strings never loaded because
 * the site locale was never set away from WordPress's en_US default.
 *
 * WordPress's own sanitize_option( 'WPLANG', ... ) (wp-includes/
 * formatting.php) silently rejects setting WPLANG to a locale whose .mo
 * files aren't actually installed on disk (get_available_languages()) —
 * a real WP-core safety feature, not something to work around. The
 * PHPUnit test environment has no language packs installed, so
 * update_option() here correctly no-ops rather than "successfully"
 * setting a locale with no translation files behind it; these tests
 * assert the honest, environment-aware behavior instead of a hardcoded
 * "always becomes fa_IR", which would only be true once `wp language
 * core install fa_IR --activate` has actually been run (a real,
 * documented one-time setup step — see the class docblock this method
 * lives under).
 */
final class LocaleTest extends WP_UnitTestCase {

	public function test_activation_sets_fa_ir_once_the_language_pack_is_installed_or_safely_no_ops_otherwise(): void {
		update_option( 'WPLANG', '' );

		Plugin::activate();

		$fa_ir_installed = in_array( 'fa_IR', get_available_languages(), true );
		$this->assertSame(
			$fa_ir_installed ? 'fa_IR' : '',
			get_option( 'WPLANG' ),
			'Must set fa_IR only when its translation files actually exist — WordPress itself silently rejects setting a locale with none installed, and this must not fight that safety behavior.'
		);
	}

	public function test_activation_never_overwrites_a_deliberately_chosen_locale(): void {
		update_option( 'WPLANG', 'de_DE' );

		Plugin::activate();

		$this->assertSame( 'de_DE', get_option( 'WPLANG' ), 'A deliberately-configured locale must survive re-activation, not be silently reset to fa_IR.' );
	}
}
