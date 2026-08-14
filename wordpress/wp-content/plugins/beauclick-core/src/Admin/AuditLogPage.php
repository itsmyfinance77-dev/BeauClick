<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;

/**
 * V2.2 Step 13 (ADMIN-02) — general admin audit log, read-only. Merges two
 * append-only sources into one feed rather than building a second table
 * duplicating what verification already records:
 *
 * - wp_bc_admin_audit_log — every other admin action (B2B approve/reject,
 *   review moderation, loyalty tier/plan/benefit config, membership
 *   grant/cancel), written by BeauClick\Core\Support\AuditLogger.
 * - wp_bc_verification_history — verification decisions, already
 *   append-only since V2.1 Step 8 (VerificationService::transition()),
 *   left completely untouched by this step.
 *
 * A single UNION ALL query (bounded LIMIT/OFFSET, never an unbounded scan)
 * keeps this genuinely one feed instead of two separate, harder-to-scan
 * lists — while writing to each source stays exactly where it already
 * lives.
 */
final class AuditLogPage {

	private const SLUG      = 'beauclick-audit-log';
	private const PER_PAGE  = 20;

	private const ACTION_LABELS = [
		'b2b_account_approved'        => 'تأیید حساب B2B',
		'b2b_account_rejected'        => 'رد حساب B2B',
		'review_moderated'            => 'بازبینی نظر',
		'loyalty_tier_created'        => 'ایجاد سطح وفاداری',
		'loyalty_tier_toggled'        => 'تغییر وضعیت سطح وفاداری',
		'loyalty_plan_created'        => 'ایجاد پلن عضویت',
		'loyalty_plan_toggled'        => 'تغییر وضعیت پلن عضویت',
		'loyalty_benefit_created'     => 'افزودن مزیت وفاداری',
		'loyalty_benefit_deleted'     => 'حذف مزیت وفاداری',
		'loyalty_membership_granted'  => 'اعطای عضویت',
		'loyalty_membership_cancelled' => 'لغو عضویت',
		'verification_pending'        => 'ثبت درخواست تأیید',
		'verification_verified'       => 'تأیید متخصص/کسب‌وکار',
		'verification_rejected'       => 'رد درخواست تأیید',
		'verification_suspended'      => 'تعلیق تأیید',
		'verification_reinstated'     => 'بازگرداندن تأیید',
		'verification_revoked'        => 'لغو تأیید',
		'privacy_deletion_approved'   => 'تأیید درخواست حذف حساب',
		'privacy_deletion_rejected'   => 'رد درخواست حذف حساب',
		'privacy_deletion_completed'  => 'انجام حذف حساب',
	];

	/** Shared with AdminMenu's "recent activity" card so both surfaces label the same action_type identically. */
	public static function label( string $action_type ): string {
		return self::ACTION_LABELS[ $action_type ] ?? $action_type;
	}

	/** Priority 7 — see OperationsHealthPage::register()'s docblock for why hook priority, not add_submenu_page()'s own $position argument, is what actually controls this menu's ordering. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 7 );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'گزارش فعالیت‌های مدیریتی', 'beauclick-core' ),
			__( 'گزارش فعالیت‌ها', 'beauclick-core' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-core' ), 403 );
		}

		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only GET filters, no state mutation.
		$page = max( 1, isset( $_GET['paged'] ) ? (int) $_GET['paged'] : 1 );
		$from = isset( $_GET['from'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['from'] ) ) : '';
		$to   = isset( $_GET['to'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['to'] ) ) : '';
		// phpcs:enable

		AdminShell::header(
			__( 'گزارش فعالیت‌های مدیریتی', 'beauclick-core' ),
			__( 'رکورد دائمی و غیرقابل‌تغییر اقدامات مدیریتی — تأیید متخصصان، تصمیم‌های B2B، بازبینی نظرات، و تنظیمات وفاداری. این گزارش فقط برای مشاهده است.', 'beauclick-core' ),
			[ [ 'label' => __( 'گزارش فعالیت‌ها', 'beauclick-core' ) ] ]
		);

		$this->render_filters( $from, $to );

		[ $items, $total ] = $this->query( $from, $to, $page );

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'اقدام', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'موجودیت', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'انجام‌دهنده', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'دلیل', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'زمان', 'beauclick-core' ) . '</th>';
		echo '</tr></thead><tbody>';

		if ( ! $items ) {
			echo '<tr><td colspan="5">' . esc_html__( 'در این بازه هیچ فعالیتی ثبت نشده است.', 'beauclick-core' ) . '</td></tr>';
		}

		foreach ( $items as $row ) {
			$actor = $row['actor_user_id'] ? get_userdata( (int) $row['actor_user_id'] ) : null;
			echo '<tr>';
			echo '<td>' . esc_html( self::label( $row['action_type'] ) ) . '</td>';
			echo '<td>' . esc_html( $row['entity_type'] . ' #' . $row['entity_id'] ) . '</td>';
			echo '<td>' . esc_html( $actor ? $actor->display_name : '—' ) . '</td>';
			echo '<td>' . esc_html( $row['reason'] ?: '—' ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['created_at'], true ) ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();

		$this->render_pagination( $page, $total, $from, $to );

		AdminShell::footer();
	}

	private function render_filters( string $from, string $to ): void {
		echo '<form method="get" class="bc-admin-filters">';
		echo '<input type="hidden" name="page" value="' . esc_attr( self::SLUG ) . '" />';
		echo '<label>' . esc_html__( 'از تاریخ', 'beauclick-core' ) . ' <input type="date" name="from" value="' . esc_attr( $from ) . '" /></label>';
		echo '<label>' . esc_html__( 'تا تاریخ', 'beauclick-core' ) . ' <input type="date" name="to" value="' . esc_attr( $to ) . '" /></label>';
		echo '<button type="submit" class="button">' . esc_html__( 'اعمال فیلتر', 'beauclick-core' ) . '</button>';
		if ( $from || $to ) {
			echo ' <a class="button" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ) . '">' . esc_html__( 'پاک کردن', 'beauclick-core' ) . '</a>';
		}
		echo '</form>';
	}

	private function render_pagination( int $page, int $total, string $from, string $to ): void {
		$pages = (int) ceil( $total / self::PER_PAGE );
		if ( $pages <= 1 ) {
			return;
		}

		echo '<p class="bc-admin-pagination">';
		for ( $i = 1; $i <= $pages; $i++ ) {
			$url = add_query_arg(
				array_filter( [ 'page' => self::SLUG, 'paged' => $i, 'from' => $from, 'to' => $to ] ),
				admin_url( 'admin.php' )
			);
			$css = 'button' . ( $i === $page ? ' button-primary' : '' );
			echo '<a class="' . esc_attr( $css ) . '" style="margin-inline-end:4px;" href="' . esc_url( $url ) . '">' . esc_html( JalaliDate::persianDigits( (string) $i ) ) . '</a>';
		}
		echo '</p>';
	}

	/**
	 * @return array{0: array<int, array<string, mixed>>, 1: int}
	 */
	private function query( string $from, string $to, int $page ): array {
		global $wpdb;

		$audit_table        = $wpdb->prefix . 'bc_admin_audit_log';
		$verification_table = $wpdb->prefix . 'bc_verification_history';

		// Both halves of the UNION need their own copy of the date-bound
		// placeholders, in the same from-then-to order, so a single
		// left-to-right $wpdb->prepare() call across the combined values
		// array lines up correctly with the combined SQL below.
		$values             = [];
		$audit_where        = '1=1';
		$verification_where = '1=1';
		if ( $from ) {
			$audit_where        .= ' AND created_at >= %s';
			$verification_where .= ' AND created_at >= %s';
		}
		if ( $to ) {
			$audit_where        .= ' AND created_at <= %s';
			$verification_where .= ' AND created_at <= %s';
		}
		if ( $from ) {
			$values[] = $from . ' 00:00:00';
		}
		if ( $to ) {
			$values[] = $to . ' 23:59:59';
		}
		$verification_values = $values; // same date bounds, independent placeholder set for the second half.

		$union_sql = "
			(SELECT id, action_type, entity_type, entity_id, actor_user_id, reason, created_at FROM {$audit_table} WHERE {$audit_where})
			UNION ALL
			(SELECT id, CONCAT('verification_', to_status) AS action_type, 'verification_provider' AS entity_type, provider_id AS entity_id, actor_user_id, reason, created_at FROM {$verification_table} WHERE {$verification_where})
		"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$all_values = array_merge( $values, $verification_values );

		$total_sql = "SELECT COUNT(*) FROM ({$union_sql}) bc_combined"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$total     = (int) ( $all_values ? $wpdb->get_var( $wpdb->prepare( $total_sql, $all_values ) ) : $wpdb->get_var( $total_sql ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$offset      = ( $page - 1 ) * self::PER_PAGE;
		$list_sql    = "SELECT * FROM ({$union_sql}) bc_combined ORDER BY created_at DESC LIMIT %d OFFSET %d"; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$list_values = array_merge( $all_values, [ self::PER_PAGE, $offset ] );
		$items       = $wpdb->get_results( $wpdb->prepare( $list_sql, $list_values ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		return [ $items ?: [], $total ];
	}
}
