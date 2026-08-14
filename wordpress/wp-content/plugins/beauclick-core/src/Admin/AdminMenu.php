<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Admin\AuditLogPage;
use BeauClick\Core\Support\JalaliDate;

/**
 * Registers the shared top-level "BeauClick" wp-admin menu — the parent
 * slug every other module's own admin/moderation page (B2B account
 * approvals, review moderation, professional verification) hangs its
 * add_submenu_page() call off of. Core owns the parent because it's the
 * one plugin every other module already depends on; the landing page
 * itself stays a thin real dashboard (not a placeholder) — pending counts
 * a moderator actually needs at a glance.
 *
 * V2.2 Step 13: grew from three raw pending-count cards into a real
 * operational overview — every V2.1 subsystem (verification queue,
 * notification delivery, loyalty grants, waitlist, retention sweeps) now
 * generates day-to-day operational load, so the landing page surfaces the
 * signals an operator actually needs at a glance, plus the most recent
 * administrative actions (from the new general audit log — see
 * AuditLogPage). Still reads only existing tables; no new metrics engine.
 */
final class AdminMenu {

	public function register(): void {
		// Priority 5 — ahead of every other beauclick-* module's own
		// admin_menu-hooked add_submenu_page( 'beauclick', ... ) call. This
		// parent's self-referencing submenu (below) must be the FIRST item
		// registered under 'beauclick', or WordPress promotes whichever
		// submenu got there first instead, regardless of plugin activation
		// order. V2.2 Step 13 also uses this same "control the hook
		// priority" mechanism to order the rest of the BeauClick admin menu
		// (OperationsHealthPage=6, AuditLogPage=7, UsersAdminPage=8,
		// VerificationReviewPage=9, AccountsAdminPage=10,
		// ReviewsAdminPage=11, LoyaltyAdminPage=12,
		// NotificationsAdminPage=13, ReferralAdminPage=14,
		// AnalyticsDashboardPage=15) — add_submenu_page()'s own $position
		// argument turned out NOT to be a stable global sort key (see
		// OperationsHealthPage::register()'s docblock for the full story),
		// so every one of those pages' priority is deliberate, not filler.
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

		$has_reviews_table = (bool) $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_reviews'" );
		$has_waitlist_table = (bool) $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_waitlist_entries'" );
		$has_notifications_table = (bool) $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_notifications'" );
		$has_verification_table = (bool) $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_verification_requests'" );

		$pending_b2b          = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_business_accounts WHERE approval_status = 'pending'" );
		$pending_reviews      = $has_reviews_table ? (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_reviews WHERE status = 'flagged'" ) : 0;
		$pending_verification = $has_verification_table ? (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_verification_requests WHERE status = 'pending'" ) : 0;
		$waitlist_backlog     = $has_waitlist_table ? (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_waitlist_entries WHERE status = 'waiting'" ) : 0;
		$failed_notifications = $has_notifications_table ? (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE status = 'failed' AND created_at >= %s", gmdate( 'Y-m-d H:i:s', time() - DAY_IN_SECONDS ) )
		) : 0;
		$total_bookings_this_month = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE created_at >= %s", current_time( 'Y-m-01' ) . ' 00:00:00' )
		);

		AdminShell::header(
			__( 'نمای کلی', 'beauclick-core' ),
			__( 'وضعیت عملیاتی پلتفرم در یک نگاه.', 'beauclick-core' )
		);

		AdminShell::cards(
			[
				[
					'label' => __( 'تأیید متخصصان در انتظار', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $pending_verification ),
					'url'   => admin_url( 'admin.php?page=beauclick-verification' ),
					'tone'  => $pending_verification > 0 ? 'warning' : 'default',
				],
				[
					'label' => __( 'حساب‌های B2B در انتظار', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $pending_b2b ),
					'url'   => admin_url( 'admin.php?page=beauclick-b2b-accounts' ),
					'tone'  => $pending_b2b > 0 ? 'warning' : 'default',
				],
				[
					'label' => __( 'نظرات پرچم‌گذاری‌شده', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $pending_reviews ),
					'url'   => admin_url( 'admin.php?page=beauclick-reviews-moderation' ),
					'tone'  => $pending_reviews > 0 ? 'warning' : 'default',
				],
				[
					'label' => __( 'اعلان‌های ناموفق (۲۴ ساعت اخیر)', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $failed_notifications ),
					'url'   => admin_url( 'admin.php?page=beauclick-notifications&status=failed' ),
					'tone'  => $failed_notifications > 0 ? 'error' : 'default',
				],
				[
					'label' => __( 'لیست انتظار فعال', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $waitlist_backlog ),
				],
				[
					'label' => __( 'رزروهای این ماه', 'beauclick-core' ),
					'value' => JalaliDate::persianDigits( (string) $total_bookings_this_month ),
				],
			]
		);

		$this->render_recent_activity();

		AdminShell::footer();
	}

	private function render_recent_activity(): void {
		global $wpdb;

		if ( ! $wpdb->get_var( "SHOW TABLES LIKE '{$wpdb->prefix}bc_admin_audit_log'" ) ) {
			return;
		}

		$recent = function_exists( 'beauclick_core' ) ? beauclick_core()->audit_log()->recent( 8 ) : [];

		echo '<h2>' . esc_html__( 'آخرین اقدامات مدیریتی', 'beauclick-core' ) . '</h2>';

		if ( ! $recent ) {
			AdminShell::empty_state( __( 'هنوز فعالیتی ثبت نشده است.', 'beauclick-core' ) );
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:900px;"><thead><tr>';
		echo '<th>' . esc_html__( 'اقدام', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'انجام‌دهنده', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'زمان', 'beauclick-core' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $recent as $row ) {
			$actor = $row['actor_user_id'] ? get_userdata( (int) $row['actor_user_id'] ) : null;
			echo '<tr>';
			echo '<td>' . esc_html( AuditLogPage::label( $row['action_type'] ) ) . '</td>';
			echo '<td>' . esc_html( $actor ? $actor->display_name : '—' ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['created_at'], true ) ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
		echo '<p><a href="' . esc_url( admin_url( 'admin.php?page=beauclick-audit-log' ) ) . '">' . esc_html__( 'مشاهدهٔ گزارش کامل فعالیت‌ها', 'beauclick-core' ) . ' &larr;</a></p>';
	}
}
