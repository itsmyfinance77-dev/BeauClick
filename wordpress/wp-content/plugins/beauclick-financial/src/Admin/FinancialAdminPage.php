<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use BeauClick\Financial\SettlementService;

/**
 * Classic wp-admin + admin-post.php page, reusing `AdminShell` (V2.2 Step
 * 13) -- same convention as every other BeauClick admin page, gated on the
 * existing `bc_manage_platform` capability, no new capability introduced.
 * Deliberately operational (task §24: "not a full accounting ERP"): two
 * views -- an overview + outstanding-by-party list, and a per-party detail
 * screen to select outstanding orders and record a settlement, or reverse a
 * past one. No general-ledger browser, no CSV export, no charts.
 */
final class FinancialAdminPage {

	private const SLUG = 'beauclick-financial';

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 14 );
		add_action( 'admin_post_bc_financial_settle', [ $this, 'handle_settle' ] );
		add_action( 'admin_post_bc_financial_reverse', [ $this, 'handle_reverse' ] );
		add_action( 'admin_post_bc_financial_set_rate', [ $this, 'handle_set_rate' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'مالی و تسویه', 'beauclick-financial' ),
			__( 'مالی و تسویه', 'beauclick-financial' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-financial' ), 403 );
		}

		$party_type = isset( $_GET['bc_party_type'] ) ? sanitize_key( wp_unslash( (string) $_GET['bc_party_type'] ) ) : null; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$party_id   = isset( $_GET['bc_party_id'] ) ? (int) $_GET['bc_party_id'] : null; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

		AdminShell::header(
			__( 'مالی و تسویه', 'beauclick-financial' ),
			null,
			[ [ 'label' => __( 'مالی و تسویه', 'beauclick-financial' ) ] ]
		);
		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-financial' ) );
		}
		if ( isset( $_GET['bc_error'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( sanitize_text_field( wp_unslash( (string) $_GET['bc_error'] ) ), 'error' ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}

		if ( $party_type && $party_id ) {
			$this->render_party_detail( $party_type, $party_id );
		} else {
			$this->render_overview();
		}

		AdminShell::footer();
	}

	private function render_overview(): void {
		$ledger  = new LedgerService();
		$totals  = $ledger->platform_totals();
		$parties = $ledger->parties_with_receivables();

		echo '<h2>' . esc_html__( 'خلاصه پلتفرم', 'beauclick-financial' ) . '</h2>';
		echo '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px; max-width:900px; margin-bottom:24px;">';
		$this->stat_card( __( 'کمیسیون پلتفرم (خالص)', 'beauclick-financial' ), $totals['commission'] );
		$this->stat_card( __( 'مطالبات متخصصان/کسب‌وکارها (خالص)', 'beauclick-financial' ), $totals['receivable'] );
		echo '<div class="bc-card" style="padding:16px;"><div style="font-size:12px;color:var(--bc-color-ink-faint);">' . esc_html__( 'تعداد سفارش‌های واجد شرایط', 'beauclick-financial' ) . '</div><div style="font-size:20px;font-weight:700;" class="bc-numeric">' . esc_html( number_format_i18n( $totals['orderCount'] ) ) . '</div></div>';
		echo '</div>';

		echo '<h2>' . esc_html__( 'نرخ کمیسیون پلتفرم', 'beauclick-financial' ) . '</h2>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;align-items:end;margin-bottom:24px;">';
		wp_nonce_field( 'bc_financial_set_rate' );
		echo '<input type="hidden" name="action" value="bc_financial_set_rate">';
		echo '<label>' . esc_html__( 'درصد کمیسیون (٪)', 'beauclick-financial' ) . '<br><input type="number" min="0" max="100" name="rate" value="' . esc_attr( (string) CommissionConfig::rate() ) . '"></label>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'ذخیره', 'beauclick-financial' ) . '</button>';
		echo '</form>';
		echo '<p style="font-size:12px;color:#666;max-width:700px;margin-top:-16px;margin-bottom:24px;">' . esc_html__( 'این عدد یک مقدار موقت برای پیاده‌سازی فنی است و نماینده تصمیم نهایی کسب‌وکار نیست. نرخ فقط روی سفارش‌های جدید اعمال می‌شود؛ رکوردهای مالی ثبت‌شده قبلی هرگز بازنویسی نمی‌شوند.', 'beauclick-financial' ) . '</p>';

		echo '<h2>' . esc_html__( 'مطالبات بر اساس طرف حساب', 'beauclick-financial' ) . '</h2>';
		echo '<div style="overflow-x:auto;">';
		echo '<table class="wp-list-table widefat fixed striped" style="min-width:700px;"><thead><tr>';
		echo '<th>' . esc_html__( 'نوع', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'نام', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'مطالبات خالص', 'beauclick-financial' ) . '</th><th></th></tr></thead><tbody>';
		if ( ! $parties ) {
			echo '<tr><td colspan="4">' . esc_html__( 'هنوز مطالبه‌ای ثبت نشده است.', 'beauclick-financial' ) . '</td></tr>';
		}
		foreach ( $parties as $party ) {
			$post = get_post( $party['partyId'] );
			echo '<tr>';
			echo '<td>' . esc_html( 'business' === $party['partyType'] ? __( 'کسب‌وکار', 'beauclick-financial' ) : __( 'متخصص', 'beauclick-financial' ) ) . '</td>';
			echo '<td>' . esc_html( $post ? $post->post_title : ( '#' . $party['partyId'] ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( number_format_i18n( $party['receivable'] ) ) . ' ' . esc_html__( 'تومان', 'beauclick-financial' ) . '</td>';
			echo '<td><a class="button" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG . '&bc_party_type=' . $party['partyType'] . '&bc_party_id=' . $party['partyId'] ) ) . '">' . esc_html__( 'مشاهده و تسویه', 'beauclick-financial' ) . '</a></td>';
			echo '</tr>';
		}
		echo '</tbody></table></div>';

		echo '<h2 style="margin-top:32px;">' . esc_html__( 'آخرین تسویه‌ها', 'beauclick-financial' ) . '</h2>';
		$this->render_settlements_table( ( new SettlementService() )->recent( 20 ), true );
	}

	private function render_party_detail( string $party_type, int $party_id ): void {
		$post = get_post( $party_id );
		echo '<p><a href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ) . '">&rarr; ' . esc_html__( 'بازگشت به خلاصه', 'beauclick-financial' ) . '</a></p>';
		echo '<h2>' . esc_html( ( $post ? $post->post_title : ( '#' . $party_id ) ) ) . '</h2>';

		$settlements = new SettlementService();
		$summary     = $settlements->party_summary( $party_type, $party_id );
		$outstanding = $settlements->outstanding_orders_for_party( $party_type, $party_id );

		echo '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:16px; max-width:700px; margin-bottom:24px;">';
		$this->stat_card( __( 'مطالبات خالص', 'beauclick-financial' ), $summary['receivableNet'] );
		$this->stat_card( __( 'تسویه‌شده', 'beauclick-financial' ), $summary['settled'] );
		$this->stat_card( __( 'باقی‌مانده', 'beauclick-financial' ), $summary['outstanding'] );
		echo '</div>';

		echo '<h3>' . esc_html__( 'سفارش‌های واجد شرایط تسویه', 'beauclick-financial' ) . '</h3>';
		if ( ! $outstanding ) {
			echo '<p>' . esc_html__( 'همه سفارش‌های این طرف حساب تسویه شده‌اند.', 'beauclick-financial' ) . '</p>';
		} else {
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="max-width:700px;">';
			wp_nonce_field( 'bc_financial_settle' );
			echo '<input type="hidden" name="action" value="bc_financial_settle">';
			echo '<input type="hidden" name="party_type" value="' . esc_attr( $party_type ) . '">';
			echo '<input type="hidden" name="party_id" value="' . esc_attr( (string) $party_id ) . '">';
			echo '<table class="wp-list-table widefat fixed striped" style="margin-bottom:12px;"><thead><tr><th></th><th>' . esc_html__( 'شماره سفارش', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'مبلغ باقی‌مانده', 'beauclick-financial' ) . '</th></tr></thead><tbody>';
			foreach ( $outstanding as $row ) {
				echo '<tr><td><input type="checkbox" name="order_ids[]" value="' . esc_attr( (string) $row['orderId'] ) . '"></td><td>#' . esc_html( (string) $row['orderId'] ) . '</td><td class="bc-numeric">' . esc_html( number_format_i18n( $row['outstanding'] ) ) . ' ' . esc_html__( 'تومان', 'beauclick-financial' ) . '</td></tr>';
			}
			echo '</tbody></table>';
			echo '<label>' . esc_html__( 'روش/مرجع پرداخت', 'beauclick-financial' ) . '<br><input type="text" name="method" style="width:100%;max-width:400px;" placeholder="' . esc_attr__( 'مثلاً انتقال بانکی - شماره پیگیری', 'beauclick-financial' ) . '"></label><br><br>';
			echo '<label>' . esc_html__( 'یادداشت (اختیاری)', 'beauclick-financial' ) . '<br><textarea name="note" style="width:100%;max-width:400px;" rows="2"></textarea></label><br><br>';
			echo '<p style="font-size:12px;color:#666;">' . esc_html__( 'ثبت این تسویه به معنای واریز واقعی وجه خارج از سامانه است — بیوکلیک هیچ انتقال بانکی خودکاری انجام نمی‌دهد.', 'beauclick-financial' ) . '</p>';
			echo '<button type="submit" class="button button-primary">' . esc_html__( 'ثبت تسویه برای سفارش‌های انتخاب‌شده', 'beauclick-financial' ) . '</button>';
			echo '</form>';
		}

		echo '<h3 style="margin-top:32px;">' . esc_html__( 'تاریخچه تسویه', 'beauclick-financial' ) . '</h3>';
		$this->render_settlements_table( $settlements->for_party( $party_type, $party_id ), false );
	}

	/** @param list<array<string, mixed>> $settlements */
	private function render_settlements_table( array $settlements, bool $show_party ): void {
		echo '<div style="overflow-x:auto;">';
		echo '<table class="wp-list-table widefat fixed striped" style="min-width:800px;"><thead><tr>';
		echo '<th>#</th>' . ( $show_party ? '<th>' . esc_html__( 'طرف حساب', 'beauclick-financial' ) . '</th>' : '' ) . '<th>' . esc_html__( 'مبلغ', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'روش', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'وضعیت', 'beauclick-financial' ) . '</th><th>' . esc_html__( 'تاریخ', 'beauclick-financial' ) . '</th><th></th></tr></thead><tbody>';
		if ( ! $settlements ) {
			echo '<tr><td colspan="7">' . esc_html__( 'هنوز تسویه‌ای ثبت نشده است.', 'beauclick-financial' ) . '</td></tr>';
		}
		foreach ( $settlements as $s ) {
			echo '<tr>';
			echo '<td>#' . esc_html( (string) $s['id'] ) . '</td>';
			if ( $show_party ) {
				$post = get_post( $s['partyId'] );
				echo '<td>' . esc_html( $post ? $post->post_title : ( '#' . $s['partyId'] ) ) . '</td>';
			}
			echo '<td class="bc-numeric">' . esc_html( number_format_i18n( $s['amount'] ) ) . ' ' . esc_html__( 'تومان', 'beauclick-financial' ) . '</td>';
			echo '<td>' . esc_html( (string) ( $s['method'] ?: '—' ) ) . '</td>';
			echo '<td>' . ( 'reversed' === $s['status'] ? esc_html__( 'برگشت‌خورده', 'beauclick-financial' ) : esc_html__( 'ثبت‌شده', 'beauclick-financial' ) ) . '</td>';
			echo '<td>' . esc_html( \BeauClick\Core\Support\JalaliDate::format( (string) $s['createdAt'], true ) ) . '</td>';
			echo '<td>';
			if ( 'recorded' === $s['status'] ) {
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline;">';
				wp_nonce_field( 'bc_financial_reverse_' . $s['id'] );
				echo '<input type="hidden" name="action" value="bc_financial_reverse">';
				echo '<input type="hidden" name="settlement_id" value="' . esc_attr( (string) $s['id'] ) . '">';
				echo '<input type="text" name="reason" placeholder="' . esc_attr__( 'دلیل برگشت', 'beauclick-financial' ) . '" required style="width:140px;">';
				echo '<button type="submit" class="button" style="color:#b32d2e;">' . esc_html__( 'برگشت', 'beauclick-financial' ) . '</button>';
				echo '</form>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table></div>';
	}

	private function stat_card( string $label, int $amount ): void {
		echo '<div class="bc-card" style="padding:16px;">';
		echo '<div style="font-size:12px;color:var(--bc-color-ink-faint);">' . esc_html( $label ) . '</div>';
		echo '<div style="font-size:20px;font-weight:700;" class="bc-numeric">' . esc_html( number_format_i18n( $amount ) ) . ' ' . esc_html__( 'تومان', 'beauclick-financial' ) . '</div>';
		echo '</div>';
	}

	// ------------------------------------------------------------------
	// admin-post.php handlers -- thin wrappers, business logic testable
	// separately via the "*_and_log()" methods below.
	// ------------------------------------------------------------------

	public function handle_settle(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_financial_settle' );

		$party_type = sanitize_key( wp_unslash( (string) ( $_POST['party_type'] ?? '' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$party_id   = (int) ( $_POST['party_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$order_ids  = array_map( 'intval', (array) ( $_POST['order_ids'] ?? [] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$method     = sanitize_text_field( wp_unslash( (string) ( $_POST['method'] ?? '' ) ) ) ?: null; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$note       = sanitize_textarea_field( wp_unslash( (string) ( $_POST['note'] ?? '' ) ) ) ?: null; // phpcs:ignore WordPress.Security.NonceVerification.Missing

		$result = $this->settle_and_log( $party_type, $party_id, $order_ids, $method, null, $note );
		$this->redirect_back( $party_type, $party_id, is_string( $result ) ? $result : null );
	}

	/** @param list<int> $order_ids @return int|string New settlement id, or a Persian error string. */
	public function settle_and_log( string $party_type, int $party_id, array $order_ids, ?string $method, ?string $reference, ?string $note ): int|string {
		$result = ( new SettlementService() )->create_settlement( $party_type, $party_id, $order_ids, $method, $reference, $note, get_current_user_id() );
		if ( is_string( $result ) ) {
			return $result;
		}
		$this->audit( 'financial_settlement_created', $result['id'], null, [ 'partyType' => $party_type, 'partyId' => $party_id, 'orderIds' => $order_ids ] );
		return $result['id'];
	}

	public function handle_reverse(): void {
		$this->assert_capability();
		$settlement_id = (int) ( $_POST['settlement_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_financial_reverse_' . $settlement_id );
		$reason = sanitize_text_field( wp_unslash( (string) ( $_POST['reason'] ?? '' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing

		$result = $this->reverse_and_log( $settlement_id, $reason );

		$settlement = ( new SettlementService() )->find( $settlement_id );
		$this->redirect_back( $settlement['partyType'] ?? null, $settlement['partyId'] ?? null, is_string( $result ) ? $result : null );
	}

	/** @return true|string */
	public function reverse_and_log( int $settlement_id, string $reason ) {
		$before = ( new SettlementService() )->find( $settlement_id );
		$result = ( new SettlementService() )->reverse_settlement( $settlement_id, get_current_user_id(), $reason );
		if ( is_string( $result ) ) {
			return $result;
		}
		$this->audit( 'financial_settlement_reversed', $settlement_id, $before ? [ 'status' => $before['status'] ] : null, [ 'status' => 'reversed', 'reason' => $reason ] );
		return true;
	}

	public function handle_set_rate(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_financial_set_rate' );
		$rate = (int) ( $_POST['rate'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing

		$this->set_rate_and_log( $rate );
		$this->redirect_back( null, null );
	}

	public function set_rate_and_log( int $rate ): void {
		$before = CommissionConfig::rate();
		CommissionConfig::set_rate( $rate );
		$this->audit( 'financial_commission_rate_changed', 0, [ 'rate' => $before ], [ 'rate' => CommissionConfig::rate() ] );
	}

	private function assert_capability(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-financial' ), 403 );
		}
	}

	/** @param array<string, mixed>|null $previous_state @param array<string, mixed>|null $new_state */
	private function audit( string $action_type, int $entity_id, ?array $previous_state, ?array $new_state ): void {
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record( $action_type, 'financial', $entity_id, get_current_user_id(), $previous_state, $new_state );
		}
	}

	private function redirect_back( ?string $party_type, ?int $party_id, ?string $error = null ): void {
		$url = admin_url( 'admin.php?page=' . self::SLUG );
		if ( $party_type && $party_id ) {
			$url .= '&bc_party_type=' . $party_type . '&bc_party_id=' . $party_id;
		}
		$url .= $error ? '&bc_error=' . rawurlencode( $error ) : '&bc_notice=1';
		wp_safe_redirect( $url );
		exit;
	}
}
