<?php
/**
 * BeauClick branding for surfaces WordPress renders itself:
 * - the browser-tab favicon on every public/front-end page and on
 *   wp-login.php (no `site_icon` option is configured anywhere in this
 *   codebase, so the tab currently shows nothing/WordPress's own default)
 * - wp-login.php's logo/link/stylesheet (native WordPress auth screens
 *   remain the administrator path — see page-auth.php's own docblock —
 *   but must not look like a bare, unbranded WordPress installation)
 *
 * wp-admin's own branding (BeauClick-owned admin pages only, never core/
 * WooCommerce screens) is handled separately by
 * `BeauClick\Core\Admin\Shell\AdminShell`, since that's plugin-registered
 * and already gated to exactly the right set of pages.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A manual `<link>` tag rather than WordPress's own `site_icon` option
 * mechanism: `site_icon` expects a raster image WP core resizes/crops
 * itself into several fixed pixel sizes, and no PNG/ICO asset exists in
 * this codebase today (only the SVG brand marks in assets/brand/) —
 * registering an unprocessed SVG as a `site_icon` attachment would skip
 * that resizing pipeline and could render incorrectly across the several
 * `sizes="..."` link tags WordPress core prints for a real site icon.
 * Every modern browser supports an SVG favicon directly, and this reuses
 * the exact same mark already used as the header logo (header.php) — no
 * new art, no core modification, standard `wp_head`/`login_head` hooks.
 */
function bc_output_favicon(): void {
	printf(
		'<link rel="icon" type="image/svg+xml" href="%s">' . "\n",
		esc_url( BEAUCLICK_THEME_URI . '/assets/brand/icon-gradient.svg' )
	);
}
add_action( 'wp_head', 'bc_output_favicon', 4 );
add_action( 'login_head', 'bc_output_favicon', 4 );

/**
 * wp-login.php's own logo link (`.login h1 a`) — WordPress core's default
 * points at wordpress.org with "Powered by WordPress" title text. These two
 * filters are the standard, documented mechanism for changing both without
 * touching core; the actual logo image swap happens in login.css below.
 */
add_filter( 'login_headerurl', static fn () => home_url( '/' ) );
add_filter( 'login_headertext', static fn () => 'BeauClick' );

add_action(
	'login_enqueue_scripts',
	static function (): void {
		wp_enqueue_style( 'beauclick-login', BEAUCLICK_THEME_URI . '/assets/css/login.css', [ 'login', 'beauclick-tokens' ], BEAUCLICK_THEME_VERSION );
	}
);
