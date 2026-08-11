<?php
/**
 * Wires the React app-shell (app/dist, built by Vite) into the theme:
 * the window.BeauClick config every mounted bundle's api.ts reads, plus a
 * helper to enqueue one bundle + its DOM mount point. Each beauclick-*
 * plugin's page templates call bc_enqueue_app_bundle() for the surfaces
 * they need — a marketplace page enqueues 'marketplace-filters', a
 * professional profile page enqueues 'booking', etc. — so no page loads
 * JS it doesn't use (architecture doc §21 per-surface code splitting).
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'wp_head',
	static function (): void {
		$config = [
			'restUrl'       => esc_url_raw( rest_url( 'beauclick/v1' ) ),
			'nonce'         => wp_create_nonce( 'wp_rest' ),
			'isLoggedIn'    => is_user_logged_in(),
			'currentUserId' => get_current_user_id(),
			'checkoutUrl'   => function_exists( 'wc_get_checkout_url' ) ? wc_get_checkout_url() : null,
			'cartUrl'       => function_exists( 'wc_get_cart_url' ) ? wc_get_cart_url() : null,
		];
		echo '<script>window.BeauClick = ' . wp_json_encode( $config ) . ';</script>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	5
);

/**
 * Enqueues one Vite-built entry. `npm run build` (app/) runs a postbuild
 * step that copies app/dist/ into this theme's own app-dist/ directory —
 * the theme is self-contained and deployable as-is; nothing outside
 * wordpress/ needs to be reachable by the web server. Reads
 * app-dist/.vite/manifest.json for the content-hashed filename. No-ops
 * quietly if app/ hasn't been built yet, rather than fataling a page —
 * local frontend work and backend work are meant to proceed independently.
 */
function bc_enqueue_app_bundle( string $bundle ): void {
	static $manifest = null;

	if ( null === $manifest ) {
		$manifest_path = BEAUCLICK_THEME_DIR . '/app-dist/.vite/manifest.json';
		$manifest      = file_exists( $manifest_path ) ? json_decode( (string) file_get_contents( $manifest_path ), true ) : [];
	}

	$entry_key = "src/mounts/{$bundle}.tsx";
	if ( ! isset( $manifest[ $entry_key ] ) ) {
		return;
	}

	$entry    = $manifest[ $entry_key ];
	$base_uri = BEAUCLICK_THEME_URI . '/app-dist/';

	if ( ! empty( $entry['file'] ) ) {
		// wp_enqueue_script() has no real ESM support — wp_script_add_data(
		// $handle, 'type', 'module' ) looks like it should add type="module"
		// but does not actually change the printed tag, so the browser loads
		// Vite's `import`-statement output as a classic script and throws
		// "Cannot use import statement outside a module". wp_enqueue_script_module()
		// (WP 6.5+, available here on 6.9.6) is the real API for this.
		wp_enqueue_script_module( "beauclick-app-{$bundle}", $base_uri . $entry['file'], [], BEAUCLICK_THEME_VERSION );
	}

	foreach ( $entry['css'] ?? [] as $css_file ) {
		wp_enqueue_style( "beauclick-app-{$bundle}-css", $base_uri . $css_file, [], BEAUCLICK_THEME_VERSION );
	}
}
