<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Admin;

use BeauClick\Core\Support\JalaliDate;

/**
 * A small, read-only operational view (matching
 * NotificationsAdminPage's own scope exactly) -- recent referrals, status,
 * dates -- for support/ops visibility into attribution/qualification/
 * reward. Deliberately not a metrics dashboard; referral volume/conversion
 * numbers live in beauclick-analytics's platform dashboard (Step 11),
 * reusing MetricsService rather than building a second one here.
 */
final class ReferralAdminPage {

	private const SLUG = 'beauclick-referral';

	private const STATUS_LABELS = [
		'pending'   => 'در انتظار',
		'qualified' => 'واجد شرایط شده',
		'rewarded'  => 'پاداش داده‌شده',
	];

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'معرفی به دوستان', 'beauclick-referral' ),
			__( 'معرفی به دوستان', 'beauclick-referral' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-referral' ), 403 );
		}

		global $wpdb;
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only filter, no state mutation.
		$status_filter = isset( $_GET['status'] ) ? sanitize_key( wp_unslash( (string) $_GET['status'] ) ) : '';
		$where         = $status_filter ? $wpdb->prepare( 'WHERE status = %s', $status_filter ) : '';
		$rows          = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_referrals {$where} ORDER BY id DESC LIMIT 100", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery

		echo '<div class="wrap" dir="rtl"><h1>' . esc_html__( 'معرفی به دوستان', 'beauclick-referral' ) . '</h1>';
		echo '<p style="font-size:12px;color:#666;">' . esc_html__( 'آخرین ۱۰۰ معرفی — برای بررسی عملیاتی. آمار کلی و نرخ تبدیل در داشبورد «آمار و تحلیل» موجود است.', 'beauclick-referral' ) . '</p>';

		echo '<p>';
		foreach ( [ '' => 'همه' ] + self::STATUS_LABELS as $value => $label ) {
			$url = admin_url( 'admin.php?page=' . self::SLUG . ( $value ? '&status=' . $value : '' ) );
			echo '<a href="' . esc_url( $url ) . '" class="button" style="margin-inline-end:6px;">' . esc_html( $label ) . '</a>';
		}
		echo '</p>';

		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'معرف', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'معرفی‌شده', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'کد', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'ثبت‌نام', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'واجد شرایط شد', 'beauclick-referral' ) . '</th>';
		echo '<th>' . esc_html__( 'پاداش داده شد', 'beauclick-referral' ) . '</th>';
		echo '</tr></thead><tbody>';

		if ( ! $rows ) {
			echo '<tr><td colspan="7">' . esc_html__( 'هنوز معرفی‌ای ثبت نشده است.', 'beauclick-referral' ) . '</td></tr>';
		}
		foreach ( $rows as $row ) {
			$referrer = get_userdata( (int) $row['referrer_user_id'] );
			$referee  = get_userdata( (int) $row['referee_user_id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $referrer ? $referrer->display_name : ( '#' . $row['referrer_user_id'] ) ) . '</td>';
			echo '<td>' . esc_html( $referee ? $referee->display_name : ( '#' . $row['referee_user_id'] ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( $row['code_used'] ) . '</td>';
			echo '<td>' . esc_html( self::STATUS_LABELS[ $row['status'] ] ?? $row['status'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['created_at'], true ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( $row['qualified_at'] ? JalaliDate::format( $row['qualified_at'], true ) : '—' ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( $row['rewarded_at'] ? JalaliDate::format( $row['rewarded_at'], true ) : '—' ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table></div>';
	}
}
