<?php
/**
 * Disables WordPress core's built-in emoji-detection script/styles.
 *
 * Every browser BeauClick targets renders emoji natively — this script's
 * only job is pinging s.w.org for a fallback image on browsers that can't,
 * which is both dead weight and (per a production-readiness audit that
 * caught it as a console error) an external dependency this Iran-hosted
 * platform has no reason to carry: it fires on every page load that
 * contains an emoji character, regardless of whether any user ever needed
 * the fallback.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'init',
	static function (): void {
		remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
		remove_action( 'admin_print_scripts', 'print_emoji_detection_script' );
		remove_action( 'wp_print_styles', 'print_emoji_styles' );
		remove_action( 'admin_print_styles', 'print_emoji_styles' );
		remove_filter( 'the_content_feed', 'wp_staticize_emoji' );
		remove_filter( 'comment_text_rss', 'wp_staticize_emoji' );
		remove_filter( 'wp_mail', 'wp_staticize_emoji_for_email' );
		add_filter( 'tiny_mce_plugins', 'bc_disable_emoji_in_tinymce' );
		add_filter( 'emoji_svg_url', '__return_false' );
	}
);

/**
 * @param array<int, string> $plugins
 * @return array<int, string>
 */
function bc_disable_emoji_in_tinymce( array $plugins ): array {
	return array_diff( $plugins, [ 'wpemoji' ] );
}
