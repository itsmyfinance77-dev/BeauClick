<?php
/**
 * BeauClick theme bootstrap.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BEAUCLICK_THEME_VERSION', '0.1.0' );
define( 'BEAUCLICK_THEME_DIR', get_template_directory() );
define( 'BEAUCLICK_THEME_URI', get_template_directory_uri() );

require_once BEAUCLICK_THEME_DIR . '/inc/helpers.php';
require_once BEAUCLICK_THEME_DIR . '/inc/app-shell.php';
require_once BEAUCLICK_THEME_DIR . '/inc/seo.php';
require_once BEAUCLICK_THEME_DIR . '/inc/sitemap.php';
require_once BEAUCLICK_THEME_DIR . '/inc/referral.php';
require_once BEAUCLICK_THEME_DIR . '/inc/performance.php';
require_once BEAUCLICK_THEME_DIR . '/inc/branding.php';
require_once BEAUCLICK_THEME_DIR . '/inc/account-redirect.php';

add_action(
	'after_setup_theme',
	static function (): void {
		add_theme_support( 'title-tag' );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'html5', [ 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption' ] );
		add_theme_support( 'woocommerce' );

		register_nav_menus(
			[
				'primary' => __( 'Primary Navigation', 'beauclick' ),
			]
		);
	}
);

/**
 * BeauClick is Persian-first, RTL-first, regardless of the WordPress admin
 * language setting (design brief §2 — "not a UI translated into Persian").
 */
add_filter(
	'language_attributes',
	static function (): string {
		return 'lang="fa" dir="rtl"';
	}
);

add_action(
	'wp_enqueue_scripts',
	static function (): void {
		// Order matters: components.css uses --bc-* custom properties that
		// beauclick-core's Support\Tokens::to_css() registers on
		// 'beauclick-tokens' (enqueued on the same hook, core loads first).
		wp_enqueue_style( 'beauclick-theme-components', BEAUCLICK_THEME_URI . '/assets/css/components.css', [ 'beauclick-tokens' ], BEAUCLICK_THEME_VERSION );
		wp_enqueue_style( 'beauclick-theme', BEAUCLICK_THEME_URI . '/assets/css/theme.css', [ 'beauclick-theme-components' ], BEAUCLICK_THEME_VERSION );

		if ( function_exists( 'is_woocommerce' ) && ( is_woocommerce() || is_cart() || is_checkout() || is_account_page() ) ) {
			wp_enqueue_style( 'beauclick-woocommerce', BEAUCLICK_THEME_URI . '/assets/css/woocommerce.css', [ 'beauclick-theme' ], BEAUCLICK_THEME_VERSION );
		}
	},
	20
);

/**
 * WooCommerce must never surface its default theme/UI (architecture doc §6,
 * design handoff line 11) — declaring support above lets Woo skip injecting
 * its own wrapper markup, and every Woo template is overridden under
 * /woocommerce in this theme (added as those pages are built — Phase 6).
 */
