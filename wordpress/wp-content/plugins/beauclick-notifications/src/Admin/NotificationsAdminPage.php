<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Admin;

/**
 * A small, read-only operational view (§28) -- recent deliveries, status,
 * failure reason, retry count -- for debugging notification problems.
 * Deliberately not a general observability dashboard; if this needs to
 * grow into one later, that's a separate Admin Platform effort, not
 * something to build speculatively here.
 */
final class NotificationsAdminPage {

	private const SLUG = 'beauclick-notifications';

	private const STATUS_LABELS = [
		'pending'    => 'در انتظار',
		'sent'       => 'ارسال‌شده',
		'failed'     => 'ناموفق',
		'suppressed' => 'سرکوب‌شده (بر اساس تنظیمات کاربر)',
		'duplicate'  => 'تکراری (نادیده گرفته‌شده)',
	];

	private const CATEGORY_LABELS = [
		'reminder'  => 'یادآوری نوبت',
		'waitlist'  => 'لیست انتظار',
		'rebooking' => 'پیشنهاد رزرو دوباره',
		'retention' => 'یادآوری بازگشت',
	];

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'اعلان‌ها', 'beauclick-notifications' ),
			__( 'اعلان‌ها', 'beauclick-notifications' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-notifications' ), 403 );
		}

		global $wpdb;
		$status_filter = isset( $_GET['status'] ) ? sanitize_key( wp_unslash( (string) $_GET['status'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$where         = $status_filter ? $wpdb->prepare( 'WHERE status = %s', $status_filter ) : '';
		$rows          = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_notifications {$where} ORDER BY id DESC LIMIT 100", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery

		echo '<div class="wrap"><h1>' . esc_html__( 'اعلان‌ها', 'beauclick-notifications' ) . '</h1>';
		echo '<p style="font-size:12px;color:#666;">' . esc_html__( 'آخرین ۱۰۰ اعلان -- برای عیب‌یابی مشکلات ارسال.', 'beauclick-notifications' ) . '</p>';

		echo '<p>';
		foreach ( [ '' => 'همه' ] + self::STATUS_LABELS as $value => $label ) {
			$url = admin_url( 'admin.php?page=' . self::SLUG . ( $value ? '&status=' . $value : '' ) );
			echo '<a href="' . esc_url( $url ) . '" class="button" style="margin-inline-end:6px;">' . esc_html( $label ) . '</a>';
		}
		echo '</p>';

		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'کاربر', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'دسته', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'کانال', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'گیرنده', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'خطا', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'تلاش‌ها', 'beauclick-notifications' ) . '</th>';
		echo '<th>' . esc_html__( 'زمان', 'beauclick-notifications' ) . '</th>';
		echo '</tr></thead><tbody>';

		if ( ! $rows ) {
			echo '<tr><td colspan="8">' . esc_html__( 'اعلانی ثبت نشده است.', 'beauclick-notifications' ) . '</td></tr>';
		}
		foreach ( $rows as $row ) {
			$user = get_userdata( (int) $row['user_id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $user ? $user->display_name : ( '#' . $row['user_id'] ) ) . '</td>';
			echo '<td>' . esc_html( self::CATEGORY_LABELS[ $row['category'] ] ?? $row['category'] ) . '</td>';
			echo '<td>' . esc_html( 'sms' === $row['channel'] ? 'پیامک' : 'ایمیل' ) . '</td>';
			echo '<td>' . esc_html( $row['recipient'] ?? '—' ) . '</td>';
			echo '<td>' . esc_html( self::STATUS_LABELS[ $row['status'] ] ?? $row['status'] ) . '</td>';
			echo '<td>' . esc_html( $row['error'] ?? '—' ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( (string) $row['attempts'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( $row['created_at'] ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table></div>';
	}
}
