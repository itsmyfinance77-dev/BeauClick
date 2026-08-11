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
		add_action( 'admin_menu', [ $this, 'add_menu' ] );
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
