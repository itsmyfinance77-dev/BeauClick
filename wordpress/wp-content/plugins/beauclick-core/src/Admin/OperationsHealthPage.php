<?php
declare( strict_types=1 );

namespace BeauClick\Core\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;

/**
 * V2.2 Step 13 — a small operational visibility layer (OPS-03's spirit,
 * scoped to what THIS application actually knows about itself), not a
 * monitoring platform. Per this step's own explicit instruction: never
 * claim an external service is "healthy" merely because a credential is
 * present — every row here distinguishes "پیکربندی‌شده" (configured; a
 * value exists) from "پیکربندی نشده" (not configured), and says so
 * explicitly rather than attempting a live reachability probe (which would
 * mean this page making real outbound network/API calls on every admin page
 * load — its own real cost/risk, and still not "verified" in any
 * trustworthy sense for a payment/SMS/AI provider). Real backup and
 * error-monitoring integration remain production/hosting decisions
 * (OPS-02/OPS-04), unchanged — this page says so plainly instead of
 * pretending they're covered.
 */
final class OperationsHealthPage {

	private const SLUG = 'beauclick-operations';

	/** @var array<string, string> cron hook => Persian label */
	private const CRON_JOBS = [
		'beauclick_booking_expire_holds'        => 'انقضای نگه‌داری‌های نوبت (هر ۵ دقیقه)',
		'beauclick_booking_send_reminders'      => 'ارسال یادآوری نوبت (ساعتی)',
		'beauclick_booking_recompute_rankings'  => 'محاسبهٔ مجدد رتبه‌بندی (ساعتی)',
		'beauclick_booking_rebooking_sweep'     => 'بررسی پیشنهاد رزرو دوباره (روزانه)',
		'beauclick_booking_retention_sweep'     => 'بررسی یادآوری بازگشت مشتری (روزانه)',
		'beauclick_booking_expire_waitlist'     => 'انقضای لیست انتظار (روزانه)',
		'beauclick_loyalty_expire_memberships'  => 'انقضای عضویت‌های وفاداری (روزانه)',
		'beauclick_notifications_retry'         => 'تلاش مجدد ارسال اعلان (ساعتی)',
	];

	/**
	 * Priority 6 — right after AdminMenu's own priority-5 self-referencing
	 * "نمای کلی" registration, ahead of every other module's default-priority
	 * (10) submenu. WordPress's add_submenu_page() $position argument only
	 * inserts relative to how many items are ALREADY in the submenu array at
	 * the moment it runs (falls back to a plain append once $position >= the
	 * current count) — it is NOT a stable, global sort key ksort() can later
	 * reorder correctly across hooks that fire at different times. A real
	 * BeauClick information-architecture order (Overview → Operations →
	 * Audit Log → Users → Verification → B2B → ...) is only achievable by
	 * controlling the *hook priority* each module's own add_page() runs at —
	 * found live, during this step's own QA pass, when a $position-only
	 * approach put "آمار و تحلیل" second in the menu (its plugin's admin_menu
	 * hook simply fires early alphabetically), not eleventh as intended.
	 */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 6 );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'عملیات و سلامت', 'beauclick-core' ),
			__( 'عملیات و سلامت', 'beauclick-core' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-core' ), 403 );
		}

		AdminShell::header(
			__( 'عملیات و سلامت پلتفرم', 'beauclick-core' ),
			__( 'وضعیت زیرساخت داخلی، وظایف زمان‌بندی‌شده، و پیکربندی سرویس‌های خارجی — یک لایهٔ دیدپذیری عملیاتی، نه یک سامانهٔ پایش کامل.', 'beauclick-core' ),
			[ [ 'label' => __( 'عملیات و سلامت', 'beauclick-core' ) ] ]
		);

		$this->render_infrastructure_section();
		$this->render_cron_section();
		$this->render_external_services_section();

		AdminShell::footer();
	}

	private function render_infrastructure_section(): void {
		global $wpdb;

		$db_reachable = null !== $wpdb->get_var( 'SELECT 1' );
		$timezone     = get_option( 'timezone_string' ) ?: ( 0.0 !== (float) get_option( 'gmt_offset' ) ? 'UTC' . get_option( 'gmt_offset' ) : '—' );

		echo '<h2>' . esc_html__( 'زیرساخت داخلی', 'beauclick-core' ) . '</h2>';
		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:720px;"><tbody>';
		$this->row( __( 'اتصال پایگاه‌داده', 'beauclick-core' ), $db_reachable ? $this->tag( 'متصل', 'success' ) : $this->tag( 'قطع', 'error' ) );
		$this->row( __( 'منطقهٔ زمانی سایت', 'beauclick-core' ), esc_html( (string) $timezone ) );
		$this->row( __( 'زبان سایت', 'beauclick-core' ), esc_html( (string) ( get_option( 'WPLANG' ) ?: 'en_US' ) ) );
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_cron_section(): void {
		echo '<h2>' . esc_html__( 'وظایف زمان‌بندی‌شده (WP-Cron)', 'beauclick-core' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'در محیط تولید، WP-Cron باید از طریق cron واقعی سیستم اجرا شود، نه صرفاً با بازدید صفحات — این یک تنظیم زیرساختی جداگانه است.', 'beauclick-core' ) . '</p>';

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'وظیفه', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-core' ) . '</th>';
		echo '<th>' . esc_html__( 'اجرای بعدی', 'beauclick-core' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( self::CRON_JOBS as $hook => $label ) {
			$next = wp_next_scheduled( $hook );
			echo '<tr>';
			echo '<td>' . esc_html( $label ) . '</td>';
			echo '<td>' . ( $next ? $this->tag( 'زمان‌بندی‌شده', 'success' ) : $this->tag( 'زمان‌بندی نشده', 'warning' ) ) . '</td>';
			echo '<td class="bc-numeric">' . ( $next ? esc_html( JalaliDate::format( get_date_from_gmt( gmdate( 'Y-m-d H:i:s', $next ), 'Y-m-d H:i:s' ), true ) ) : '—' ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_external_services_section(): void {
		echo '<h2>' . esc_html__( 'سرویس‌های خارجی', 'beauclick-core' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'وضعیت «پیکربندی‌شده» فقط به معنای وجود مقدار است — نه اتصال یا صحت آن. هیچ اطلاعات محرمانه‌ای در این صفحه نمایش داده نمی‌شود.', 'beauclick-core' ) . '</p>';

		$services = [
			[ 'label' => __( 'پیامک (OTP و اعلان‌ها)', 'beauclick-core' ), 'configured' => '' !== $this->env( 'BC_SMS_PROVIDER' ) && '' !== $this->env( 'BC_SMS_API_KEY' ) ],
			[ 'label' => __( 'ایمیل تراکنشی (SMTP)', 'beauclick-core' ), 'configured' => false ],
			[ 'label' => __( 'درگاه پرداخت (زرین‌پال)', 'beauclick-core' ), 'configured' => '' !== $this->env( 'ZARINPAL_MERCHANT_ID' ) ],
			[ 'label' => __( 'ارائه‌دهندهٔ هوش مصنوعی', 'beauclick-core' ), 'configured' => '' !== $this->env( 'BC_AI_PROVIDER' ) && '' !== $this->env( 'BC_AI_API_KEY' ) ],
			[ 'label' => __( 'ذخیره‌سازی رسانه', 'beauclick-core' ), 'configured' => 'local' !== ( $this->env( 'BC_STORAGE_DRIVER' ) ?: 'local' ) ],
		];

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:720px;"><thead><tr>';
		echo '<th>' . esc_html__( 'سرویس', 'beauclick-core' ) . '</th><th>' . esc_html__( 'وضعیت', 'beauclick-core' ) . '</th></tr></thead><tbody>';
		foreach ( $services as $s ) {
			echo '<tr><td>' . esc_html( $s['label'] ) . '</td><td>' . ( $s['configured'] ? $this->tag( 'پیکربندی‌شده (بررسی‌نشده)', 'warning' ) : $this->tag( 'پیکربندی نشده', 'error' ) ) . '</td></tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();

		echo '<p class="description" style="max-width:720px;">' . esc_html__( 'پشتیبان‌گیری خودکار و پایش خطا (مانند Sentry) بخشی از این پلتفرم نیستند و باید در سطح میزبانی/زیرساخت پیکربندی شوند.', 'beauclick-core' ) . '</p>';
	}

	private function env( string $key ): string {
		return function_exists( 'bc_env' ) ? bc_env( $key ) : '';
	}

	private function row( string $label, string $value_html ): void {
		echo '<tr><th style="text-align:start;width:40%;">' . esc_html( $label ) . '</th><td style="text-align:start;">' . $value_html . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- value_html is pre-escaped by callers (esc_html() or self::tag()).
	}

	private function tag( string $label, string $tone ): string {
		return '<span class="bc-admin-tag bc-admin-tag--' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}
}
