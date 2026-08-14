<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Admin;

use BeauClick\Analytics\Metrics\MetricsService;
use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;

/**
 * The ANLYT-04 dashboard — a real, purpose-built wp-admin page (raw
 * PHP/HTML, no React mount — matching this project's established admin-page
 * convention, e.g. VerificationReviewPage/NotificationsAdminPage), reusing
 * the shared 'beauclick' top-level menu.
 *
 * Numbers are ALWAYS computed live for the selected range on every page
 * load — this is stated explicitly in the page header (§35's own "don't
 * claim real-time if refreshed hourly/daily" instruction, inverted: this
 * page IS genuinely live on every request, so it says so plainly rather
 * than leaving freshness ambiguous).
 *
 * Every number is presented in a real `<table>` (never a canvas-only
 * chart) — §31's own accessibility requirement that a visualization
 * without an accessible textual/table equivalent isn't acceptable. This
 * page has no chart at all, only tables, which trivially satisfies that
 * without needing to design a parallel non-visual view of a chart that
 * doesn't exist.
 */
final class AnalyticsDashboardPage {

	private const SLUG = 'beauclick-analytics';

	/** Hook priority (not add_submenu_page()'s own $position argument — see BeauClick\Core\Admin\OperationsHealthPage::register()'s docblock) is what places this menu last in the intended BeauClick admin order — found live, during this step's own QA pass, wrongly appearing second when only $position was used, since this plugin's admin_menu hook otherwise fires alphabetically early. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 15 );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'آمار و تحلیل', 'beauclick-analytics' ),
			__( 'آمار و تحلیل', 'beauclick-analytics' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	/** @return array{jy:int,jm:int} the current site-local date's Jalali year/month. */
	private function current_jalali_year_month(): array {
		$j = JalaliDate::toJalali( (int) current_time( 'Y' ), (int) current_time( 'n' ), (int) current_time( 'j' ) );
		return [ 'jy' => $j['jy'], 'jm' => $j['jm'] ];
	}

	/** @return array{0:string,1:string} Gregorian Y-m-d bounds of the current Jalali month. */
	private function this_jalali_month_range(): array {
		[ 'jy' => $jy, 'jm' => $jm ] = $this->current_jalali_year_month();

		$days_in_month = $jm <= 6 ? 31 : ( $jm <= 11 ? 30 : ( JalaliDate::isLeapYear( $jy ) ? 30 : 29 ) );

		$start = JalaliDate::toGregorian( $jy, $jm, 1 );
		$end   = JalaliDate::toGregorian( $jy, $jm, $days_in_month );

		return [
			sprintf( '%04d-%02d-%02d', $start['gy'], $start['gm'], $start['gd'] ),
			sprintf( '%04d-%02d-%02d', $end['gy'], $end['gm'], $end['gd'] ),
		];
	}

	private function preset_range( string $preset ): array {
		$today = current_time( 'Y-m-d' );

		return match ( $preset ) {
			'today'      => [ $today, $today ],
			'last7'      => [ gmdate( 'Y-m-d', strtotime( $today . ' -6 days' ) ), $today ],
			'this_month' => $this->this_jalali_month_range(),
			default      => [ gmdate( 'Y-m-d', strtotime( $today . ' -29 days' ) ), $today ], // last30
		};
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-analytics' ), 403 );
		}

		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only GET filters, no state mutation.
		$preset       = isset( $_GET['range'] ) ? sanitize_key( wp_unslash( (string) $_GET['range'] ) ) : 'last30';
		$custom_from  = isset( $_GET['from'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['from'] ) ) : '';
		$custom_to    = isset( $_GET['to'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['to'] ) ) : '';
		// phpcs:enable

		if ( $custom_from || $custom_to ) {
			[ $from, $to ] = MetricsService::normalize_range( $custom_from ?: null, $custom_to ?: null );
			$preset        = 'custom';
		} else {
			[ $from, $to ] = $this->preset_range( $preset );
		}

		$service = new MetricsService();
		$data    = [
			'overview'    => $service->overview( $from, $to ),
			'funnel'      => $service->funnel( $from, $to ),
			'commerce'    => $service->commerce( $from, $to ),
			'search'      => $service->search( $from, $to ),
			'ai'          => $service->ai( $from, $to ),
			'retention'   => $service->retention( $from, $to ),
			'usage'       => $service->usage( $from, $to ),
			'referral'    => $service->referral( $from, $to ),
			'marketplace' => $service->marketplace( $from, $to ),
		];

		AdminShell::header(
			__( 'آمار و تحلیل پلتفرم', 'beauclick-analytics' ),
			__( 'همهٔ اعداد در همین لحظه و مستقیماً از رویدادها و جداول واقعی محاسبه می‌شوند (نه گزارش ذخیره‌شدهٔ روزانه).', 'beauclick-analytics' ),
			[ [ 'label' => __( 'آمار و تحلیل', 'beauclick-analytics' ) ] ]
		);

		$this->render_range_picker( $preset, $from, $to );

		echo '<p style="font-size:13px;color:#333;">' . sprintf(
			/* translators: 1: Jalali start date, 2: Jalali end date */
			esc_html__( 'بازهٔ نمایش‌داده‌شده: %1$s تا %2$s', 'beauclick-analytics' ),
			esc_html( JalaliDate::format( $from . ' 00:00:00' ) ),
			esc_html( JalaliDate::format( $to . ' 00:00:00' ) )
		) . '</p>';

		$this->render_section(
			__( 'نمای کلی پلتفرم', 'beauclick-analytics' ),
			[
				__( 'کاربران جدید', 'beauclick-analytics' )               => $this->num( $data['overview']['newSignups'] ),
				__( 'مشتریان (کل)', 'beauclick-analytics' )                => $this->num( $data['overview']['usersByRole']['customer'] ),
				__( 'متخصصان فعال (کل)', 'beauclick-analytics' )           => $this->num( $data['overview']['activeProfessionals'] ),
				__( 'نوبت‌های تکمیل‌شده', 'beauclick-analytics' )          => $this->num( $data['overview']['bookingsCompleted'] ),
				__( 'سفارش‌های تکمیل‌شده (نوبت + فروشگاه)', 'beauclick-analytics' ) => $this->num( $data['overview']['ordersCompletedAllTypes'] ),
				__( 'درآمد ناخالص (تومان)', 'beauclick-analytics' )        => $this->num( (int) $data['overview']['grossRevenueAllTypes'] ),
				__( 'مبلغ بازگشتی (تومان)', 'beauclick-analytics' )        => $this->num( (int) $data['overview']['refundedAmountAllTypes'] ),
				__( 'درآمد خالص (تومان)', 'beauclick-analytics' )          => $this->num( (int) $data['overview']['netRevenueAllTypes'] ),
			]
		);

		$this->render_section(
			__( 'قیف نوبت‌دهی', 'beauclick-analytics' ),
			[
				__( 'شروع نوبت', 'beauclick-analytics' )      => $this->num( $data['funnel']['started'] ),
				__( 'تأییدشده', 'beauclick-analytics' )       => $this->num( $data['funnel']['confirmed'] ),
				__( 'تکمیل‌شده', 'beauclick-analytics' )      => $this->num( $data['funnel']['completed'] ),
				__( 'لغوشده', 'beauclick-analytics' )         => $this->num( $data['funnel']['cancelled'] ),
				__( 'منقضی‌شده', 'beauclick-analytics' )      => $this->num( $data['funnel']['expired'] ),
				__( 'عدم حضور', 'beauclick-analytics' )       => $this->num( $data['funnel']['noShow'] ),
				__( 'نرخ تبدیل (تکمیل÷شروع)', 'beauclick-analytics' ) => $this->pct( $data['funnel']['conversionRate'] ),
			]
		);

		$this->render_section(
			__( 'قیف فروشگاه (بدون نوبت)', 'beauclick-analytics' ),
			[
				__( 'بازدید محصول', 'beauclick-analytics' )       => $this->num( $data['commerce']['productViews'] ),
				__( 'افزودن به سبد خرید', 'beauclick-analytics' ) => $this->num( $data['commerce']['cartAdds'] ),
				__( 'شروع تسویه‌حساب', 'beauclick-analytics' )    => $this->num( $data['commerce']['checkoutStarted'] ),
				__( 'سفارش تکمیل‌شده', 'beauclick-analytics' )    => $this->num( $data['commerce']['ordersCompleted'] ),
				__( 'سفارش بازگشتی', 'beauclick-analytics' )      => $this->num( $data['commerce']['ordersRefunded'] ),
				__( 'نرخ تبدیل تسویه‌حساب', 'beauclick-analytics' ) => $this->pct( $data['commerce']['checkoutConversionRate'] ),
			]
		);

		$this->render_section(
			__( 'جست‌وجو', 'beauclick-analytics' ),
			[
				__( 'کل جست‌وجوها', 'beauclick-analytics' )          => $this->num( $data['search']['totalSearches'] ),
				__( 'جست‌وجوکنندگان یکتا', 'beauclick-analytics' )   => $this->num( $data['search']['uniqueSearchers'] ),
				__( 'جست‌وجوی بدون نتیجه', 'beauclick-analytics' )   => $this->num( $data['search']['zeroResultSearches'] ),
				__( 'نرخ بدون‌نتیجه', 'beauclick-analytics' )        => $this->pct( $data['search']['zeroResultRate'] ),
				__( 'استفاده از فیلتر تخصص', 'beauclick-analytics' ) => $this->num( $data['search']['specialtyFilterUsage'] ),
				__( 'استفاده از فیلتر موقعیت', 'beauclick-analytics' ) => $this->num( $data['search']['locationFilterUsage'] ),
			]
		);

		$this->render_section(
			__( 'دستیار هوشمند', 'beauclick-analytics' ),
			[
				__( 'باز شدن دستیار', 'beauclick-analytics' )        => $this->num( $data['ai']['assistantOpened'] ),
				__( 'پیشنهاد نمایش‌داده‌شده', 'beauclick-analytics' ) => $this->num( $data['ai']['recommendationsShown'] ),
				__( 'پیشنهاد کلیک‌شده', 'beauclick-analytics' )       => $this->num( $data['ai']['recommendationsClicked'] ),
				__( 'نرخ کلیک', 'beauclick-analytics' )               => $this->pct( $data['ai']['clickThroughRate'] ),
			]
		);

		echo '<h2>' . esc_html__( 'بازگشت مشتری (Retention)', 'beauclick-analytics' ) . '</h2>';
		$this->render_section(
			__( 'لیست انتظار و اعلان‌ها', 'beauclick-analytics' ),
			[
				__( 'عضویت در لیست انتظار', 'beauclick-analytics' ) => $this->num( $data['retention']['waitlistJoined'] ),
				__( 'لغو از لیست انتظار', 'beauclick-analytics' )  => $this->num( $data['retention']['waitlistCancelled'] ),
				__( 'پیشنهاد نوبت خالی ارسال‌شده', 'beauclick-analytics' ) => $this->num( $data['retention']['waitlistOffersSent'] ),
				__( 'یادآوری نوبت ارسال‌شده', 'beauclick-analytics' ) => $this->num( $data['retention']['notificationsSent']['reminder'] ),
				__( 'پیشنهاد رزرو دوباره ارسال‌شده', 'beauclick-analytics' ) => $this->num( $data['retention']['notificationsSent']['rebooking'] ),
				__( 'یادآوری بازگشت ارسال‌شده', 'beauclick-analytics' ) => $this->num( $data['retention']['notificationsSent']['retention'] ),
				__( 'نوبت‌های بازیابی‌شده (تقریبی)', 'beauclick-analytics' ) => $this->num( $data['retention']['recoveredBookings'] ),
			]
		);
		echo '<p style="font-size:12px;color:#888;max-width:640px;">' . esc_html( $data['retention']['recoveredBookingsCaveat'] ) . '</p>';

		$this->render_section(
			__( 'معرفی به دوستان (Referral)', 'beauclick-analytics' ),
			[
				__( 'اشتراک‌گذاری لینک معرفی', 'beauclick-analytics' )    => $this->num( $data['referral']['linkShared'] ),
				__( 'ثبت‌نام با معرفی', 'beauclick-analytics' )           => $this->num( $data['referral']['signupsAttributed'] ),
				__( 'واجد شرایط شده', 'beauclick-analytics' )             => $this->num( $data['referral']['qualified'] ),
				__( 'پاداش داده‌شده', 'beauclick-analytics' )             => $this->num( $data['referral']['rewarded'] ),
				__( 'نرخ واجد شرایط شدن', 'beauclick-analytics' )         => $this->pct( $data['referral']['qualificationRate'] ),
				__( 'مجموع امتیاز پاداش صادرشده', 'beauclick-analytics' ) => $this->num( $data['referral']['rewardPointsIssued'] ),
			]
		);

		$this->render_section(
			__( 'استفاده از پنل حرفه‌ای‌ها و باشگاه مشتریان', 'beauclick-analytics' ),
			[
				__( 'باز شدن مدیریت مشتریان (CRM)', 'beauclick-analytics' ) => $this->num( $data['usage']['crmOpened'] ),
				__( 'باز شدن مسیر زیبایی من', 'beauclick-analytics' )      => $this->num( $data['usage']['journeyOpened'] ),
			]
		);

		$this->render_section(
			__( 'بازار', 'beauclick-analytics' ),
			[
				__( 'عرضهٔ متخصصان (فعلی)', 'beauclick-analytics' ) => $this->num( $data['marketplace']['professionalSupply'] ),
				__( 'بازدید پروفایل', 'beauclick-analytics' )       => $this->num( $data['marketplace']['profileViews'] ),
			]
		);

		echo '<p style="font-size:12px;color:#888;max-width:640px;">' . esc_html__( 'دسترسی حرفه‌ای‌ها/کسب‌وکارها به آمار اختصاصی خودشان در این مرحله ساخته نشده و برای گام بعدی مستند شده است.', 'beauclick-analytics' ) . '</p>';

		AdminShell::footer();
	}

	private function render_range_picker( string $active, string $from, string $to ): void {
		$presets = [
			'today'      => __( 'امروز', 'beauclick-analytics' ),
			'last7'      => __( '۷ روز اخیر', 'beauclick-analytics' ),
			'last30'     => __( '۳۰ روز اخیر', 'beauclick-analytics' ),
			'this_month' => __( 'این ماه شمسی', 'beauclick-analytics' ),
		];

		echo '<p>';
		foreach ( $presets as $key => $label ) {
			$url  = admin_url( 'admin.php?page=' . self::SLUG . '&range=' . $key );
			$css  = 'button' . ( $active === $key ? ' button-primary' : '' );
			echo '<a href="' . esc_url( $url ) . '" class="' . esc_attr( $css ) . '" style="margin-inline-end:6px;">' . esc_html( $label ) . '</a>';
		}
		echo '</p>';

		echo '<form method="get" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">';
		echo '<input type="hidden" name="page" value="' . esc_attr( self::SLUG ) . '" />';
		echo '<label>' . esc_html__( 'از تاریخ (میلادی)', 'beauclick-analytics' ) . ' <input type="date" name="from" value="' . esc_attr( $from ) . '" /></label>';
		echo '<label>' . esc_html__( 'تا تاریخ (میلادی)', 'beauclick-analytics' ) . ' <input type="date" name="to" value="' . esc_attr( $to ) . '" /></label>';
		echo '<button type="submit" class="button">' . esc_html__( 'اعمال بازهٔ دلخواه', 'beauclick-analytics' ) . '</button>';
		echo '</form>';
	}

	/** @param array<string,string> $rows label => already-formatted value */
	private function render_section( string $title, array $rows ): void {
		echo '<h2>' . esc_html( $title ) . '</h2>';
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:640px;"><tbody>';
		foreach ( $rows as $label => $value ) {
			echo '<tr><th style="text-align:start;width:60%;">' . esc_html( $label ) . '</th><td style="text-align:start;">' . esc_html( $value ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private function num( int $n ): string {
		return JalaliDate::persianDigits( number_format( $n ) );
	}

	private function pct( float $ratio ): string {
		return JalaliDate::persianDigits( number_format( $ratio * 100, 1 ) ) . '٪';
	}
}
