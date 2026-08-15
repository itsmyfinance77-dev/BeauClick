<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Admin;

use BeauClick\Campaigns\CampaignService;
use BeauClick\Core\Admin\Shell\AdminShell;

/**
 * Classic wp-admin + admin-post.php page, following the exact convention
 * `LoyaltyAdminPage` already established for an admin-authored promotional-
 * economics domain — not a REST API. This is a deliberate deviation from the
 * task's own "if REST is required" framing (§24): the closest real
 * precedent in this codebase (Loyalty's tier/benefit/membership admin
 * configuration) uses classic wp-admin exclusively, and Step 13's own
 * established rationale for every BeauClick admin page (low-frequency
 * internal tooling; the React app-shell only exists for the customer/
 * professional/business-facing surfaces, none of which show a campaign
 * picker — campaign selection is always server-resolved, never client-
 * supplied) applies here too. Gated on `bc_manage_platform`, the same
 * capability every other platform-configuration admin screen already uses —
 * no new capability was introduced, per RoleManager's own "prefer a small,
 * understandable capability model" precedent.
 */
final class CampaignAdminPage {

	private const SLUG = 'beauclick-campaigns';

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 13 );
		add_action( 'admin_post_bc_campaign_create', [ $this, 'handle_create' ] );
		add_action( 'admin_post_bc_campaign_update', [ $this, 'handle_update' ] );
		add_action( 'admin_post_bc_campaign_activate', [ $this, 'handle_activate' ] );
		add_action( 'admin_post_bc_campaign_pause', [ $this, 'handle_pause' ] );
		add_action( 'admin_post_bc_campaign_archive', [ $this, 'handle_archive' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'کمپین‌ها', 'beauclick-campaigns' ),
			__( 'کمپین‌ها', 'beauclick-campaigns' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-campaigns' ), 403 );
		}

		$service    = new CampaignService();
		$campaigns  = $service->all();
		$editing_id = isset( $_GET['bc_edit'] ) ? (int) $_GET['bc_edit'] : null; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$editing    = $editing_id ? $service->find( $editing_id ) : null;

		AdminShell::header(
			__( 'کمپین‌ها', 'beauclick-campaigns' ),
			null,
			[ [ 'label' => __( 'کمپین‌ها', 'beauclick-campaigns' ) ] ]
		);
		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-campaigns' ) );
		}
		if ( isset( $_GET['bc_error'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( sanitize_text_field( wp_unslash( (string) $_GET['bc_error'] ) ), 'error' ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}

		$this->render_list( $campaigns, $service );
		$this->render_form( $editing );

		AdminShell::footer();
	}

	private function render_list( array $campaigns, CampaignService $service ): void {
		echo '<h2>' . esc_html__( 'کمپین‌های موجود', 'beauclick-campaigns' ) . '</h2>';
		echo '<div style="overflow-x:auto;">';
		echo '<table class="wp-list-table widefat fixed striped" style="min-width:1000px;"><thead><tr>';
		echo '<th>' . esc_html__( 'نام', 'beauclick-campaigns' ) . '</th>';
		echo '<th>' . esc_html__( 'تخفیف', 'beauclick-campaigns' ) . '</th>';
		echo '<th>' . esc_html__( 'محدوده', 'beauclick-campaigns' ) . '</th>';
		echo '<th>' . esc_html__( 'بازه زمانی', 'beauclick-campaigns' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-campaigns' ) . '</th>';
		echo '<th>' . esc_html__( 'مصرف / مجموع تخفیف', 'beauclick-campaigns' ) . '</th>';
		echo '<th></th></tr></thead><tbody>';

		if ( ! $campaigns ) {
			echo '<tr><td colspan="7">' . esc_html__( 'هنوز کمپینی تعریف نشده است.', 'beauclick-campaigns' ) . '</td></tr>';
		}

		foreach ( $campaigns as $campaign ) {
			$summary = $service->usage_summary( $campaign['id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $campaign['name'] ) . '</td>';
			echo '<td>' . esc_html( $this->format_discount( $campaign ) ) . '</td>';
			echo '<td>' . esc_html( $this->format_scope( $campaign['customerScope'] ) ) . '</td>';
			echo '<td>' . esc_html( $this->format_window( $campaign ) ) . '</td>';
			echo '<td>' . esc_html( $this->format_status( $campaign['status'] ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( sprintf( '%d / %s تومان', $summary['count'], number_format_i18n( $summary['totalDiscount'] ) ) ) . '</td>';
			echo '<td>' . $this->render_row_actions( $campaign ) . '</td>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo '</tr>';
		}
		echo '</tbody></table></div>';
	}

	private function render_row_actions( array $campaign ): string {
		$out  = '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
		$out .= '<a class="button" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG . '&bc_edit=' . $campaign['id'] ) ) . '">' . esc_html__( 'ویرایش', 'beauclick-campaigns' ) . '</a>';

		if ( in_array( $campaign['status'], [ CampaignService::STATUS_DRAFT, CampaignService::STATUS_PAUSED ], true ) ) {
			$out .= $this->action_form( 'bc_campaign_activate', $campaign['id'], __( 'فعال‌سازی', 'beauclick-campaigns' ) );
		}
		if ( CampaignService::STATUS_ACTIVE === $campaign['status'] ) {
			$out .= $this->action_form( 'bc_campaign_pause', $campaign['id'], __( 'توقف موقت', 'beauclick-campaigns' ) );
		}
		if ( CampaignService::STATUS_ARCHIVED !== $campaign['status'] ) {
			$out .= $this->action_form( 'bc_campaign_archive', $campaign['id'], __( 'بایگانی', 'beauclick-campaigns' ), true );
		}

		return $out . '</div>';
	}

	private function action_form( string $action, int $id, string $label, bool $danger = false ): string {
		$out  = '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		$out .= wp_nonce_field( $action . '_' . $id, '_wpnonce', true, false );
		$out .= '<input type="hidden" name="action" value="' . esc_attr( $action ) . '">';
		$out .= '<input type="hidden" name="campaign_id" value="' . esc_attr( (string) $id ) . '">';
		$out .= '<button type="submit" class="button' . ( $danger ? '' : '' ) . '" style="' . ( $danger ? 'color:#b32d2e;' : '' ) . '">' . esc_html( $label ) . '</button>';
		return $out . '</form>';
	}

	private function render_form( ?array $editing ): void {
		$is_edit = null !== $editing;
		echo '<h2 style="margin-top:32px;">' . ( $is_edit ? esc_html__( 'ویرایش کمپین', 'beauclick-campaigns' ) : esc_html__( 'افزودن کمپین جدید', 'beauclick-campaigns' ) ) . '</h2>';

		if ( $is_edit && CampaignService::STATUS_ARCHIVED === $editing['status'] ) {
			echo '<p>' . esc_html__( 'کمپین بایگانی‌شده قابل ویرایش نیست.', 'beauclick-campaigns' ) . '</p>';
			return;
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;max-width:1100px;">';
		wp_nonce_field( $is_edit ? 'bc_campaign_update_' . $editing['id'] : 'bc_campaign_create' );
		echo '<input type="hidden" name="action" value="' . ( $is_edit ? 'bc_campaign_update' : 'bc_campaign_create' ) . '">';
		if ( $is_edit ) {
			echo '<input type="hidden" name="campaign_id" value="' . esc_attr( (string) $editing['id'] ) . '">';
		}

		$v = static fn ( string $key, $default = '' ) => $is_edit ? ( $editing[ $key ] ?? $default ) : $default;

		echo '<label>' . esc_html__( 'نام کمپین', 'beauclick-campaigns' ) . '<br><input type="text" name="name" required value="' . esc_attr( (string) $v( 'name' ) ) . '"></label>';

		echo '<label>' . esc_html__( 'نوع تخفیف', 'beauclick-campaigns' ) . '<br><select name="discount_type">';
		echo '<option value="' . esc_attr( CampaignService::TYPE_PERCENTAGE ) . '" ' . selected( $v( 'discountType', CampaignService::TYPE_PERCENTAGE ), CampaignService::TYPE_PERCENTAGE, false ) . '>' . esc_html__( 'درصدی', 'beauclick-campaigns' ) . '</option>';
		echo '<option value="' . esc_attr( CampaignService::TYPE_FIXED ) . '" ' . selected( $v( 'discountType' ), CampaignService::TYPE_FIXED, false ) . '>' . esc_html__( 'مبلغ ثابت (تومان)', 'beauclick-campaigns' ) . '</option>';
		echo '</select></label>';

		echo '<label>' . esc_html__( 'مقدار تخفیف', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="discount_value" required value="' . esc_attr( (string) $v( 'discountValue' ) ) . '"></label>';
		echo '<label>' . esc_html__( 'حداکثر مبلغ تخفیف (اختیاری، فقط درصدی)', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="max_discount_amount" value="' . esc_attr( (string) $v( 'maxDiscountAmount', '' ) ) . '"></label>';

		echo '<label>' . esc_html__( 'شروع (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="datetime-local" name="starts_at" value="' . esc_attr( $this->to_datetime_local( $v( 'startsAt' ) ) ) . '"></label>';
		echo '<label>' . esc_html__( 'پایان (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="datetime-local" name="ends_at" value="' . esc_attr( $this->to_datetime_local( $v( 'endsAt' ) ) ) . '"></label>';

		echo '<label>' . esc_html__( 'شناسه خدمت هدف (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="service_id" value="' . esc_attr( (string) $v( 'serviceId', '' ) ) . '"></label>';
		echo '<label>' . esc_html__( 'شناسه متخصص هدف (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="provider_id" value="' . esc_attr( (string) $v( 'providerId', '' ) ) . '"></label>';

		echo '<label>' . esc_html__( 'محدوده مشتری', 'beauclick-campaigns' ) . '<br><select name="customer_scope">';
		echo '<option value="' . esc_attr( CampaignService::SCOPE_ALL ) . '" ' . selected( $v( 'customerScope', CampaignService::SCOPE_ALL ), CampaignService::SCOPE_ALL, false ) . '>' . esc_html__( 'همه مشتریان', 'beauclick-campaigns' ) . '</option>';
		echo '<option value="' . esc_attr( CampaignService::SCOPE_FIRST_BOOKING ) . '" ' . selected( $v( 'customerScope' ), CampaignService::SCOPE_FIRST_BOOKING, false ) . '>' . esc_html__( 'فقط اولین رزرو', 'beauclick-campaigns' ) . '</option>';
		echo '<option value="' . esc_attr( CampaignService::SCOPE_RETURNING ) . '" ' . selected( $v( 'customerScope' ), CampaignService::SCOPE_RETURNING, false ) . '>' . esc_html__( 'فقط مشتریان بازگشتی', 'beauclick-campaigns' ) . '</option>';
		echo '</select></label>';

		echo '<label>' . esc_html__( 'حداقل مبلغ سفارش (اختیاری، تومان)', 'beauclick-campaigns' ) . '<br><input type="number" min="0" name="min_order_value" value="' . esc_attr( (string) $v( 'minOrderValue', '' ) ) . '"></label>';
		echo '<label>' . esc_html__( 'سقف مصرف کل کمپین (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="usage_limit_total" value="' . esc_attr( (string) $v( 'usageLimitTotal', '' ) ) . '"></label>';
		echo '<label>' . esc_html__( 'سقف مصرف هر مشتری (اختیاری)', 'beauclick-campaigns' ) . '<br><input type="number" min="1" name="usage_limit_per_customer" value="' . esc_attr( (string) $v( 'usageLimitPerCustomer', '' ) ) . '"></label>';

		echo '<button type="submit" class="button button-primary">' . ( $is_edit ? esc_html__( 'ذخیره تغییرات', 'beauclick-campaigns' ) : esc_html__( 'افزودن کمپین', 'beauclick-campaigns' ) ) . '</button>';
		if ( $is_edit ) {
			echo '<a class="button" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ) . '">' . esc_html__( 'انصراف', 'beauclick-campaigns' ) . '</a>';
		}
		echo '</form>';
		echo '<p style="font-size:12px;color:#666;max-width:900px;">' . esc_html__( 'کمپین جدید همیشه به‌صورت پیش‌نویس ساخته می‌شود و تا فعال‌سازی دستی، روی هیچ رزروی اعمال نمی‌شود. کمپین فقط روی سفارش‌های رزرو نوبت اعمال می‌شود (نه خرید مستقیم از فروشگاه یا سفارش‌های B2B) و همیشه سمت سرور محاسبه و اعمال می‌شود — مبلغ تخفیف هرگز از مرورگر دریافت نمی‌شود.', 'beauclick-campaigns' ) . '</p>';
	}

	private function to_datetime_local( $value ): string {
		if ( ! $value ) {
			return '';
		}
		$ts = strtotime( (string) $value );
		return $ts ? gmdate( 'Y-m-d\TH:i', $ts ) : '';
	}

	private function format_discount( array $campaign ): string {
		if ( CampaignService::TYPE_PERCENTAGE === $campaign['discountType'] ) {
			$suffix = $campaign['maxDiscountAmount'] ? sprintf( ' (حداکثر %s تومان)', number_format_i18n( $campaign['maxDiscountAmount'] ) ) : '';
			return $campaign['discountValue'] . '٪' . $suffix;
		}
		return number_format_i18n( $campaign['discountValue'] ) . ' تومان';
	}

	private function format_scope( string $scope ): string {
		return match ( $scope ) {
			CampaignService::SCOPE_FIRST_BOOKING => __( 'اولین رزرو', 'beauclick-campaigns' ),
			CampaignService::SCOPE_RETURNING     => __( 'مشتری بازگشتی', 'beauclick-campaigns' ),
			default                              => __( 'همه', 'beauclick-campaigns' ),
		};
	}

	private function format_status( string $status ): string {
		return match ( $status ) {
			CampaignService::STATUS_ACTIVE   => __( 'فعال', 'beauclick-campaigns' ),
			CampaignService::STATUS_PAUSED   => __( 'متوقف‌شده', 'beauclick-campaigns' ),
			CampaignService::STATUS_ARCHIVED => __( 'بایگانی‌شده', 'beauclick-campaigns' ),
			default                          => __( 'پیش‌نویس', 'beauclick-campaigns' ),
		};
	}

	private function format_window( array $campaign ): string {
		if ( ! $campaign['startsAt'] && ! $campaign['endsAt'] ) {
			return __( 'نامحدود', 'beauclick-campaigns' );
		}
		$start = $campaign['startsAt'] ? \BeauClick\Core\Support\JalaliDate::format( $campaign['startsAt'], true ) : '—';
		$end   = $campaign['endsAt'] ? \BeauClick\Core\Support\JalaliDate::format( $campaign['endsAt'], true ) : '—';
		return $start . ' تا ' . $end;
	}

	// ------------------------------------------------------------------
	// admin-post.php handlers — thin nonce/capability/redirect wrappers.
	// The actual, audited business logic lives in the "*_and_log()" methods
	// below, tested directly (mirrors LoyaltyAdminPage's own convention:
	// handle_*() ends in wp_safe_redirect()+exit and can't run inside a test
	// process).
	// ------------------------------------------------------------------

	public function handle_create(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_campaign_create' );

		$result = $this->create_campaign_and_log( $this->fields_from_request( get_current_user_id() ) );
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_update(): void {
		$this->assert_capability();
		$id = (int) ( $_POST['campaign_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_campaign_update_' . $id );

		$result = $this->update_campaign_and_log( $id, $this->fields_from_request( null ) );
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_activate(): void {
		$this->transition_action( 'bc_campaign_activate', 'activate_and_log' );
	}

	public function handle_pause(): void {
		$this->transition_action( 'bc_campaign_pause', 'pause_and_log' );
	}

	public function handle_archive(): void {
		$this->transition_action( 'bc_campaign_archive', 'archive_and_log' );
	}

	private function transition_action( string $nonce_action, string $method ): void {
		$this->assert_capability();
		$id = (int) ( $_POST['campaign_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( $nonce_action . '_' . $id );

		$result = $this->{$method}( $id );
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	/** @param array<string, mixed> $fields @return int|string New campaign id on success, a Persian error string on failure. */
	public function create_campaign_and_log( array $fields ): int|string {
		$result = ( new CampaignService() )->create( $fields );
		if ( is_string( $result ) ) {
			return $result;
		}
		$id = (int) $result['id'];
		$this->audit( 'campaign_created', $id, null, [ 'name' => $fields['name'] ?? null ] );
		return $id;
	}

	/** @param array<string, mixed> $fields @return array<string, mixed>|string Updated campaign on success, a Persian error string on failure. */
	public function update_campaign_and_log( int $id, array $fields ) {
		$before = ( new CampaignService() )->find( $id );
		$result = ( new CampaignService() )->update( $id, $fields );
		if ( is_string( $result ) ) {
			return $result;
		}
		$this->audit( 'campaign_updated', $id, $before, $result );
		return $result;
	}

	/** @return true|string */
	public function activate_and_log( int $id ) {
		return $this->transition_and_log( $id, 'activate', 'campaign_activated' );
	}

	/** @return true|string */
	public function pause_and_log( int $id ) {
		return $this->transition_and_log( $id, 'pause', 'campaign_paused' );
	}

	/** @return true|string */
	public function archive_and_log( int $id ) {
		return $this->transition_and_log( $id, 'archive', 'campaign_archived' );
	}

	/** @return true|string */
	private function transition_and_log( int $id, string $service_method, string $audit_action ) {
		$service = new CampaignService();
		$before  = $service->find( $id );
		$result  = $service->{$service_method}( $id );
		if ( is_string( $result ) ) {
			return $result;
		}
		$this->audit( $audit_action, $id, $before ? [ 'status' => $before['status'] ] : null, [ 'status' => $service->find( $id )['status'] ?? null ] );
		return true;
	}

	/** @return array<string, mixed> */
	private function fields_from_request( ?int $created_by ): array {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing
		$fields = [
			'name'                   => sanitize_text_field( wp_unslash( (string) ( $_POST['name'] ?? '' ) ) ),
			'discountType'           => sanitize_key( wp_unslash( (string) ( $_POST['discount_type'] ?? '' ) ) ),
			'discountValue'          => $_POST['discount_value'] ?? 0,
			'maxDiscountAmount'      => $_POST['max_discount_amount'] ?? '',
			'startsAt'               => $this->from_datetime_local( (string) ( $_POST['starts_at'] ?? '' ) ),
			'endsAt'                 => $this->from_datetime_local( (string) ( $_POST['ends_at'] ?? '' ) ),
			'serviceId'              => $_POST['service_id'] ?? '',
			'providerId'             => $_POST['provider_id'] ?? '',
			'customerScope'          => sanitize_key( wp_unslash( (string) ( $_POST['customer_scope'] ?? CampaignService::SCOPE_ALL ) ) ),
			'minOrderValue'          => $_POST['min_order_value'] ?? '',
			'usageLimitTotal'        => $_POST['usage_limit_total'] ?? '',
			'usageLimitPerCustomer'  => $_POST['usage_limit_per_customer'] ?? '',
		];
		// phpcs:enable WordPress.Security.NonceVerification.Missing
		if ( null !== $created_by ) {
			$fields['createdBy'] = $created_by;
		}
		return $fields;
	}

	private function from_datetime_local( string $value ): string {
		if ( '' === $value ) {
			return '';
		}
		$ts = strtotime( $value . ':00' );
		return $ts ? gmdate( 'Y-m-d H:i:s', $ts ) : '';
	}

	private function assert_capability(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-campaigns' ), 403 );
		}
	}

	/** @param array<string, mixed>|null $previous_state @param array<string, mixed>|null $new_state */
	private function audit( string $action_type, int $entity_id, ?array $previous_state, ?array $new_state ): void {
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record( $action_type, 'campaign', $entity_id, get_current_user_id(), $previous_state, $new_state );
		}
	}

	private function redirect_back( ?string $error = null ): void {
		$url = admin_url( 'admin.php?page=' . self::SLUG . ( $error ? '&bc_error=' . rawurlencode( $error ) : '&bc_notice=1' ) );
		wp_safe_redirect( $url );
		exit;
	}
}
