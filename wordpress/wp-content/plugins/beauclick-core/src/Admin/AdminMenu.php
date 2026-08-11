<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin;

/**
 * Registers the shared top-level "BeauClick" wp-admin menu — the parent
 * slug every other module's own admin/moderation page (B2B account
 * approvals, review moderation, professional verification) hangs its
 * add_submenu_page() call off of. Core owns the parent because it's the
 * one plugin every other module already depends on; the landing page
 * itself stays a thin real dashboard (not a placeholder) — pending counts
 * a moderator actually needs at a glance.
 */
final class AdminMenu {

	public function register(): void {
		// Priority 5, ahead of every other beauclick-* module's own
		// admin_menu-hooked add_submenu_page( 'beauclick', ... ) call (all at
		// the default 10) — this parent's self-referencing submenu (below)
		// must be the FIRST item registered under 'beauclick', or WordPress
		// promotes whichever submenu got there first instead, regardless of
		// plugin activation order.
		add_action( 'admin_menu', [ $this, 'add_menu' ], 5 );
	}

	public function add_menu(): void {
		add_menu_page(
			__( 'BeauClick', 'beauclick-core' ),
			__( 'BeauClick', 'beauclick-core' ),
			'bc_manage_platform',
			'beauclick',
			[ $this, 'render' ],
			'dashicons-store',
			30
		);

		/**
		 * Without this, WordPress's own menu-building (wp-admin/includes/
		 * menu.php) auto-promotes whichever OTHER module's submenu happens to
		 * register first under 'beauclick' (B2B accounts, review moderation,
		 * ...) into this parent's effective landing page — silently
		 * rewriting the parent slug everywhere. That rewrite happens only
		 * for menu *rendering*, but the promoted page's actual permission
		 * hook was registered against the ORIGINAL 'beauclick' parent, so
		 * user_can_access_admin_page() looks up a hookname that was never
		 * registered and denies access outright — for an admin who does
		 * have the capability. A live verification pass caught this as a
		 * real 403 on whichever submenu happened to load first. The fix WP
		 * core itself documents for this exact case: explicitly register a
		 * submenu with the SAME slug as the parent, so WordPress never needs
		 * to guess a landing page.
		 */
		add_submenu_page(
			'beauclick',
			__( 'BeauClick', 'beauclick-core' ),
			__( 'نمای کلی', 'beauclick-core' ),
			'bc_manage_platform',
			'beauclick',
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		global $wpdb;

		$pending_b2b     = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_business_accounts WHERE approval_status = 'pending'" );
		$pending_reviews = $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_reviews'" )
			? (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_reviews WHERE status = 'flagged'" )
			: 0;
		$total_bookings_this_month = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE created_at >= %s", current_time( 'Y-m-01' ) . ' 00:00:00' )
		);
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'BeauClick', 'beauclick-core' ); ?></h1>
			<div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:16px;">
				<div class="card" style="max-width:240px;">
					<h2 class="title"><?php esc_html_e( 'حساب‌های B2B در انتظار', 'beauclick-core' ); ?></h2>
					<p style="font-size:28px; font-weight:700;"><?php echo esc_html( (string) $pending_b2b ); ?></p>
					<?php if ( $pending_b2b > 0 ) : ?>
						<p><a href="<?php echo esc_url( admin_url( 'admin.php?page=beauclick-b2b-accounts' ) ); ?>"><?php esc_html_e( 'بررسی درخواست‌ها', 'beauclick-core' ); ?></a></p>
					<?php endif; ?>
				</div>
				<div class="card" style="max-width:240px;">
					<h2 class="title"><?php esc_html_e( 'نظرات پرچم‌گذاری‌شده', 'beauclick-core' ); ?></h2>
					<p style="font-size:28px; font-weight:700;"><?php echo esc_html( (string) $pending_reviews ); ?></p>
					<p><a href="<?php echo esc_url( admin_url( 'admin.php?page=beauclick-reviews-moderation' ) ); ?>"><?php esc_html_e( 'بازبینی نظرات', 'beauclick-core' ); ?></a></p>
				</div>
				<div class="card" style="max-width:240px;">
					<h2 class="title"><?php esc_html_e( 'رزروهای این ماه', 'beauclick-core' ); ?></h2>
					<p style="font-size:28px; font-weight:700;"><?php echo esc_html( (string) $total_bookings_this_month ); ?></p>
				</div>
			</div>
		</div>
		<?php
	}
}
