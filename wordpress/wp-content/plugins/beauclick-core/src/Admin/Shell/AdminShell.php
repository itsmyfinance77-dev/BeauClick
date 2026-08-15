<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin\Shell;

/**
 * Shared visual shell for every BeauClick wp-admin page — a thin layer on
 * top of native wp-admin, never a replacement for it (V2.2 Step 13's own
 * "do not rewrite wp-admin" instruction). Every BeauClick admin page
 * already lives under the same 'beauclick' top-level menu and already uses
 * wp-admin's own list-table/notice/button classes; this class adds one
 * consistent header/breadcrumb, a small stat-card grid component, an
 * empty-state helper, and a horizontally-scrollable table wrapper (so a
 * wide table scrolls inside itself rather than causing page-level
 * horizontal overflow on a 375–412px screen) — plus a single CSS file
 * (assets/admin/admin-shell.css) enqueued ONLY on BeauClick's own admin
 * screens, never touching any other wp-admin page, plugin, or WooCommerce
 * screen.
 *
 * Deliberately not a templating engine: every method still just echoes
 * plain, escaped HTML, matching the exact style every existing BeauClick
 * admin page (VerificationReviewPage, LoyaltyAdminPage, ...) already uses —
 * introducing a template layer here would be a bigger change than this
 * step's own "coherent layer on top of WordPress, not a competing CMS"
 * scope calls for.
 */
final class AdminShell {

	public static function register(): void {
		add_action( 'admin_enqueue_scripts', [ self::class, 'maybe_enqueue' ] );
		add_action( 'admin_head', [ self::class, 'maybe_favicon' ] );
	}

	/**
	 * $hook_suffix for every BeauClick page is either
	 * "toplevel_page_beauclick" (the parent's own self-referencing submenu)
	 * or "beauclick_page_{slug}"/"{parent}_page_{slug}" for every other
	 * submenu — WordPress's own get_plugin_page_hookname() naming
	 * convention (never hand-picked here). Matching on "page_beauclick"
	 * covers both without hard-coding every current and future submenu
	 * slug.
	 */
	public static function maybe_enqueue( string $hook_suffix ): void {
		if ( ! str_contains( $hook_suffix, 'page_beauclick' ) ) {
			return;
		}

		wp_enqueue_style(
			'beauclick-admin-shell',
			plugins_url( 'assets/admin/admin-shell.css', BEAUCLICK_CORE_FILE ),
			[],
			BEAUCLICK_CORE_VERSION
		);
	}

	/**
	 * Browser-tab favicon override, BeauClick's own admin pages only — never
	 * forced onto native wp-admin screens (Plugins, Users, Settings,
	 * WooCommerce), matching this step's own "do not blindly override native
	 * WordPress identity on every technical screen" instruction. Reuses the
	 * same SVG mark the public theme uses (see the theme's inc/branding.php),
	 * read via get_stylesheet_directory_uri() rather than the theme's own
	 * constant, since this is a plugin, not the theme itself.
	 */
	public static function maybe_favicon(): void {
		$screen = get_current_screen();
		if ( ! $screen || ! str_contains( $screen->id, 'beauclick' ) ) {
			return;
		}
		printf(
			'<link rel="icon" type="image/svg+xml" href="%s">' . "\n",
			esc_url( get_stylesheet_directory_uri() . '/assets/brand/icon-gradient.svg' )
		);
	}

	/**
	 * Opens the page wrapper and prints a consistent header. Callers MUST
	 * call footer() once, at the very end of their own render() method —
	 * this class intentionally doesn't buffer or auto-close, matching every
	 * existing BeauClick admin page's own "echo directly, top to bottom"
	 * style rather than introducing output buffering.
	 *
	 * @param array<int, array{label:string,url?:string}> $breadcrumbs Extra crumbs after "بیوکلیک" — usually just the current page's own label.
	 */
	public static function header( string $title, ?string $subtitle = null, array $breadcrumbs = [] ): void {
		echo '<div class="wrap bc-admin" dir="rtl">';
		echo '<div class="bc-admin-header">';

		echo '<nav class="bc-admin-breadcrumbs" aria-label="' . esc_attr__( 'مسیر دسترسی', 'beauclick-core' ) . '">';
		echo '<a href="' . esc_url( admin_url( 'admin.php?page=beauclick' ) ) . '" class="bc-admin-brand">';
		echo '<img src="' . esc_url( get_stylesheet_directory_uri() . '/assets/brand/icon-gradient.svg' ) . '" width="16" height="16" alt="">';
		echo esc_html__( 'بیوکلیک', 'beauclick-core' );
		echo '</a>';
		foreach ( $breadcrumbs as $crumb ) {
			echo '<span class="bc-admin-breadcrumb-sep" aria-hidden="true">/</span>';
			if ( ! empty( $crumb['url'] ) ) {
				echo '<a href="' . esc_url( $crumb['url'] ) . '">' . esc_html( $crumb['label'] ) . '</a>';
			} else {
				echo '<span aria-current="page">' . esc_html( $crumb['label'] ) . '</span>';
			}
		}
		echo '</nav>';

		echo '<h1 class="bc-admin-title">' . esc_html( $title ) . '</h1>';
		if ( $subtitle ) {
			echo '<p class="bc-admin-subtitle">' . esc_html( $subtitle ) . '</p>';
		}
		echo '</div>';
	}

	public static function footer(): void {
		echo '</div>';
	}

	public static function notice( string $message, string $type = 'success' ): void {
		$css_class = match ( $type ) {
			'error'   => 'notice-error',
			'warning' => 'notice-warning',
			default   => 'notice-success',
		};
		echo '<div role="status" class="notice ' . esc_attr( $css_class ) . ' is-dismissible bc-admin-notice"><p>' . esc_html( $message ) . '</p></div>';
	}

	/**
	 * A small grid of stat cards for an operational overview — value must
	 * already be a formatted (Persian-digit) string; this component doesn't
	 * format numbers itself.
	 *
	 * @param array<int, array{label:string,value:string,url?:string,tone?:string}> $cards tone: default|warning|error|success
	 */
	public static function cards( array $cards ): void {
		if ( ! $cards ) {
			return;
		}
		echo '<div class="bc-admin-cards">';
		foreach ( $cards as $card ) {
			$tone = $card['tone'] ?? 'default';
			echo '<div class="bc-admin-card bc-admin-card--' . esc_attr( $tone ) . '">';
			echo '<span class="bc-admin-card-label">' . esc_html( $card['label'] ) . '</span>';
			echo '<span class="bc-admin-card-value">' . esc_html( $card['value'] ) . '</span>';
			if ( ! empty( $card['url'] ) ) {
				echo '<a class="bc-admin-card-link" href="' . esc_url( $card['url'] ) . '">' . esc_html__( 'مشاهده', 'beauclick-core' ) . ' &larr;</a>';
			}
			echo '</div>';
		}
		echo '</div>';
	}

	public static function empty_state( string $message ): void {
		echo '<p class="bc-admin-empty">' . esc_html( $message ) . '</p>';
	}

	/** Wrap a wp-list-table in this pair so a wide table scrolls inside itself instead of overflowing the page on a narrow screen. */
	public static function table_open(): void {
		echo '<div class="bc-admin-table-scroll">';
	}

	public static function table_close(): void {
		echo '</div>';
	}
}
