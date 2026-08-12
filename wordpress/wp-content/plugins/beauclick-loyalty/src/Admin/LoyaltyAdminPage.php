<?php
declare( strict_types=1 );

namespace BeauClick\Loyalty\Admin;

use BeauClick\Loyalty\Benefits\BenefitService;
use BeauClick\Loyalty\Membership\MembershipService;
use BeauClick\Loyalty\Tiers\TierService;

/**
 * V2.1 Step 9 — small, local admin tooling for tier/plan/benefit
 * configuration and manual membership grant/revoke, following the exact
 * classic wp-admin form + admin-post.php pattern already established by
 * VerificationReviewPage/AccountsAdminPage/ReviewsAdminPage — not a new
 * admin platform. Gated on `bc_manage_platform`, the same capability every
 * other platform-configuration admin screen in this codebase already uses.
 * Tier thresholds, benefit values, and membership prices entered here are
 * whatever the business decides — this page invents no default economics
 * of its own (see this step's own architecture notes for the
 * NEEDS_BUSINESS_DECISION items).
 */
final class LoyaltyAdminPage {

	private const SLUG = 'beauclick-loyalty';

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ] );
		add_action( 'admin_post_bc_loyalty_tier_create', [ $this, 'handle_tier_create' ] );
		add_action( 'admin_post_bc_loyalty_tier_toggle', [ $this, 'handle_tier_toggle' ] );
		add_action( 'admin_post_bc_loyalty_plan_create', [ $this, 'handle_plan_create' ] );
		add_action( 'admin_post_bc_loyalty_plan_toggle', [ $this, 'handle_plan_toggle' ] );
		add_action( 'admin_post_bc_loyalty_benefit_create', [ $this, 'handle_benefit_create' ] );
		add_action( 'admin_post_bc_loyalty_benefit_delete', [ $this, 'handle_benefit_delete' ] );
		add_action( 'admin_post_bc_loyalty_membership_grant', [ $this, 'handle_membership_grant' ] );
		add_action( 'admin_post_bc_loyalty_membership_cancel', [ $this, 'handle_membership_cancel' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'وفاداری و عضویت', 'beauclick-loyalty' ),
			__( 'وفاداری و عضویت', 'beauclick-loyalty' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-loyalty' ), 403 );
		}

		$tier_service       = new TierService();
		$membership_service = new MembershipService();
		$benefit_service    = new BenefitService();
		$tiers              = $tier_service->all( false );
		$plans              = $membership_service->plans( false );

		echo '<div class="wrap"><h1>' . esc_html__( 'وفاداری و عضویت', 'beauclick-loyalty' ) . '</h1>';
		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__( 'انجام شد.', 'beauclick-loyalty' ) . '</p></div>';
		}
		if ( isset( $_GET['bc_error'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error is-dismissible"><p>' . esc_html( sanitize_text_field( wp_unslash( $_GET['bc_error'] ) ) ) . '</p></div>'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}

		$this->render_tiers_section( $tiers, $benefit_service );
		$this->render_plans_section( $plans, $tiers, $benefit_service );
		$this->render_membership_lookup_section( $membership_service );

		echo '</div>';
	}

	private function render_tiers_section( array $tiers, BenefitService $benefit_service ): void {
		echo '<h2>' . esc_html__( 'سطوح وفاداری', 'beauclick-loyalty' ) . '</h2>';
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:900px;"><thead><tr>';
		echo '<th>' . esc_html__( 'نام', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'شناسه', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'حد نصاب امتیاز', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'وضعیت', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'مزایا', 'beauclick-loyalty' ) . '</th><th></th></tr></thead><tbody>';

		if ( ! $tiers ) {
			echo '<tr><td colspan="6">' . esc_html__( 'هنوز سطحی تعریف نشده است.', 'beauclick-loyalty' ) . '</td></tr>';
		}
		foreach ( $tiers as $tier ) {
			echo '<tr>';
			echo '<td>' . esc_html( $tier['name'] ) . '</td>';
			echo '<td>' . esc_html( $tier['slug'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( (string) $tier['thresholdPoints'] ) . '</td>';
			echo '<td>' . ( $tier['isActive'] ? esc_html__( 'فعال', 'beauclick-loyalty' ) : esc_html__( 'غیرفعال', 'beauclick-loyalty' ) ) . '</td>';
			echo '<td>' . $this->render_benefits_list( $benefit_service->for_source( BenefitService::SOURCE_TIER, $tier['id'], false ) ) . '</td>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo '<td>';
			$this->render_toggle_form( 'bc_loyalty_tier_toggle', 'tier_id', $tier['id'], ! $tier['isActive'] );
			echo '</td></tr>';
		}
		echo '</tbody></table>';

		echo '<h3>' . esc_html__( 'افزودن سطح جدید', 'beauclick-loyalty' ) . '</h3>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;max-width:900px;">';
		wp_nonce_field( 'bc_loyalty_tier_create' );
		echo '<input type="hidden" name="action" value="bc_loyalty_tier_create">';
		echo '<label>' . esc_html__( 'شناسه', 'beauclick-loyalty' ) . '<br><input type="text" name="slug" required></label>';
		echo '<label>' . esc_html__( 'نام', 'beauclick-loyalty' ) . '<br><input type="text" name="name" required></label>';
		echo '<label>' . esc_html__( 'حد نصاب امتیاز', 'beauclick-loyalty' ) . '<br><input type="number" min="0" name="threshold_points" required></label>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'افزودن', 'beauclick-loyalty' ) . '</button>';
		echo '</form>';

		echo '<h3>' . esc_html__( 'افزودن مزیت به یک سطح', 'beauclick-loyalty' ) . '</h3>';
		$this->render_benefit_form( BenefitService::SOURCE_TIER, $tiers );
	}

	private function render_plans_section( array $plans, array $tiers, BenefitService $benefit_service ): void {
		echo '<h2 style="margin-top:32px;">' . esc_html__( 'پلن‌های عضویت', 'beauclick-loyalty' ) . '</h2>';
		echo '<table class="wp-list-table widefat fixed striped" style="max-width:1000px;"><thead><tr>';
		echo '<th>' . esc_html__( 'نام', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'سطح مرتبط', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'پولی', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'قیمت (تومان)', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'وضعیت', 'beauclick-loyalty' ) . '</th><th>' . esc_html__( 'مزایا', 'beauclick-loyalty' ) . '</th><th></th></tr></thead><tbody>';

		if ( ! $plans ) {
			echo '<tr><td colspan="7">' . esc_html__( 'هنوز پلنی تعریف نشده است.', 'beauclick-loyalty' ) . '</td></tr>';
		}
		$tiers_by_id = array_column( $tiers, 'name', 'id' );
		foreach ( $plans as $plan ) {
			echo '<tr>';
			echo '<td>' . esc_html( $plan['name'] ) . '</td>';
			echo '<td>' . esc_html( $plan['tierId'] ? ( $tiers_by_id[ $plan['tierId'] ] ?? '—' ) : '—' ) . '</td>';
			echo '<td>' . ( $plan['isPaid'] ? esc_html__( 'بله', 'beauclick-loyalty' ) : esc_html__( 'رایگان', 'beauclick-loyalty' ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( null !== $plan['price'] ? (string) $plan['price'] : '—' ) . '</td>';
			echo '<td>' . ( $plan['isActive'] ? esc_html__( 'فعال', 'beauclick-loyalty' ) : esc_html__( 'غیرفعال', 'beauclick-loyalty' ) ) . '</td>';
			echo '<td>' . $this->render_benefits_list( $benefit_service->for_source( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plan['id'], false ) ) . '</td>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo '<td>';
			$this->render_toggle_form( 'bc_loyalty_plan_toggle', 'plan_id', $plan['id'], ! $plan['isActive'] );
			echo '</td></tr>';
		}
		echo '</tbody></table>';

		echo '<h3>' . esc_html__( 'افزودن پلن عضویت جدید', 'beauclick-loyalty' ) . '</h3>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;max-width:1000px;">';
		wp_nonce_field( 'bc_loyalty_plan_create' );
		echo '<input type="hidden" name="action" value="bc_loyalty_plan_create">';
		echo '<label>' . esc_html__( 'شناسه', 'beauclick-loyalty' ) . '<br><input type="text" name="slug" required></label>';
		echo '<label>' . esc_html__( 'نام', 'beauclick-loyalty' ) . '<br><input type="text" name="name" required></label>';
		echo '<label>' . esc_html__( 'سطح مرتبط (اختیاری)', 'beauclick-loyalty' ) . '<br><select name="tier_id"><option value="">—</option>';
		foreach ( $tiers as $tier ) {
			echo '<option value="' . esc_attr( (string) $tier['id'] ) . '">' . esc_html( $tier['name'] ) . '</option>';
		}
		echo '</select></label>';
		echo '<label><input type="checkbox" name="is_paid" value="1"> ' . esc_html__( 'پولی', 'beauclick-loyalty' ) . '</label>';
		echo '<label>' . esc_html__( 'قیمت (تومان، اختیاری)', 'beauclick-loyalty' ) . '<br><input type="number" min="0" name="price"></label>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'افزودن', 'beauclick-loyalty' ) . '</button>';
		echo '</form>';
		echo '<p style="font-size:12px;color:#666;max-width:700px;">' . esc_html__( 'توجه: قیمت‌گذاری واقعی و صدور صورتحساب دوره‌ای برای پلن‌های پولی نیازمند تصمیم کسب‌وکار و اتصال به درگاه/زیرساخت پرداخت تکرارشونده است که در این مرحله پیاده‌سازی نشده — فعال‌سازی عضویت در حال حاضر فقط به‌صورت دستی توسط مدیر ممکن است.', 'beauclick-loyalty' ) . '</p>';

		echo '<h3>' . esc_html__( 'افزودن مزیت به یک پلن', 'beauclick-loyalty' ) . '</h3>';
		$this->render_benefit_form( BenefitService::SOURCE_MEMBERSHIP_PLAN, $plans );
	}

	private function render_benefit_form( string $source_type, array $sources ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;max-width:1000px;margin-bottom:20px;">';
		wp_nonce_field( 'bc_loyalty_benefit_create' );
		echo '<input type="hidden" name="action" value="bc_loyalty_benefit_create">';
		echo '<input type="hidden" name="source_type" value="' . esc_attr( $source_type ) . '">';
		echo '<label>' . esc_html__( 'منبع', 'beauclick-loyalty' ) . '<br><select name="source_id" required>';
		foreach ( $sources as $s ) {
			echo '<option value="' . esc_attr( (string) $s['id'] ) . '">' . esc_html( $s['name'] ) . '</option>';
		}
		echo '</select></label>';
		echo '<label>' . esc_html__( 'نوع مزیت', 'beauclick-loyalty' ) . '<br><select name="benefit_type">';
		echo '<option value="' . esc_attr( BenefitService::TYPE_BONUS_POINTS_MULTIPLIER ) . '">' . esc_html__( 'ضریب امتیاز اضافه', 'beauclick-loyalty' ) . '</option>';
		echo '<option value="' . esc_attr( BenefitService::TYPE_DISCOUNT_PERCENTAGE ) . '">' . esc_html__( 'درصد تخفیف رزرو', 'beauclick-loyalty' ) . '</option>';
		echo '<option value="' . esc_attr( BenefitService::TYPE_DESCRIPTIVE ) . '">' . esc_html__( 'توضیحی (بدون اثر خودکار)', 'beauclick-loyalty' ) . '</option>';
		echo '</select></label>';
		echo '<label>' . esc_html__( 'عنوان مزیت', 'beauclick-loyalty' ) . '<br><input type="text" name="label" required></label>';
		echo '<label>' . esc_html__( 'مقدار (ضریب یا درصد، در صورت نیاز)', 'beauclick-loyalty' ) . '<br><input type="number" step="0.1" min="0" name="value"></label>';
		echo '<button type="submit" class="button">' . esc_html__( 'افزودن مزیت', 'beauclick-loyalty' ) . '</button>';
		echo '</form>';
	}

	private function render_benefits_list( array $benefits ): string {
		if ( ! $benefits ) {
			return '<span style="color:#999;">' . esc_html__( 'بدون مزیت', 'beauclick-loyalty' ) . '</span>';
		}
		$out = '<ul style="margin:0;padding-inline-start:16px;">';
		foreach ( $benefits as $b ) {
			$out .= '<li>' . esc_html( $b['label'] ) . ( $b['isActive'] ? '' : ' (' . esc_html__( 'غیرفعال', 'beauclick-loyalty' ) . ')' );
			$out .= ' <form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline;">';
			$out .= wp_nonce_field( 'bc_loyalty_benefit_delete_' . $b['id'], '_wpnonce', true, false );
			$out .= '<input type="hidden" name="action" value="bc_loyalty_benefit_delete">';
			$out .= '<input type="hidden" name="benefit_id" value="' . esc_attr( (string) $b['id'] ) . '">';
			$out .= '<button type="submit" class="button-link" style="color:#b32d2e;">' . esc_html__( 'حذف', 'beauclick-loyalty' ) . '</button></form></li>';
		}
		return $out . '</ul>';
	}

	private function render_toggle_form( string $action, string $id_field, int $id, bool $activate ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( $action . '_' . $id );
		echo '<input type="hidden" name="action" value="' . esc_attr( $action ) . '">';
		echo '<input type="hidden" name="' . esc_attr( $id_field ) . '" value="' . esc_attr( (string) $id ) . '">';
		echo '<button type="submit" class="button">' . ( $activate ? esc_html__( 'فعال‌سازی', 'beauclick-loyalty' ) : esc_html__( 'غیرفعال‌سازی', 'beauclick-loyalty' ) ) . '</button>';
		echo '</form>';
	}

	private function render_membership_lookup_section( MembershipService $membership_service ): void {
		echo '<h2 style="margin-top:32px;">' . esc_html__( 'اعطای دستی عضویت', 'beauclick-loyalty' ) . '</h2>';
		echo '<p style="font-size:12px;color:#666;max-width:700px;">' . esc_html__( 'تا زمانی که یک درگاه پرداخت تکرارشونده واقعی متصل نشده، تنها راه فعال‌سازی عضویت پولی، اعطای دستی توسط مدیر است.', 'beauclick-loyalty' ) . '</p>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;max-width:800px;">';
		wp_nonce_field( 'bc_loyalty_membership_grant' );
		echo '<input type="hidden" name="action" value="bc_loyalty_membership_grant">';
		echo '<label>' . esc_html__( 'ایمیل کاربر', 'beauclick-loyalty' ) . '<br><input type="email" name="email" required></label>';
		echo '<label>' . esc_html__( 'پلن عضویت', 'beauclick-loyalty' ) . '<br><select name="plan_id" required>';
		foreach ( $membership_service->plans( true ) as $plan ) {
			echo '<option value="' . esc_attr( (string) $plan['id'] ) . '">' . esc_html( $plan['name'] ) . '</option>';
		}
		echo '</select></label>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'اعطای عضویت', 'beauclick-loyalty' ) . '</button>';
		echo '</form>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;max-width:800px;margin-top:12px;">';
		wp_nonce_field( 'bc_loyalty_membership_cancel' );
		echo '<input type="hidden" name="action" value="bc_loyalty_membership_cancel">';
		echo '<label>' . esc_html__( 'ایمیل کاربر', 'beauclick-loyalty' ) . '<br><input type="email" name="email" required></label>';
		echo '<button type="submit" class="button">' . esc_html__( 'لغو عضویت', 'beauclick-loyalty' ) . '</button>';
		echo '</form>';
	}

	// ------------------------------------------------------------------
	// admin-post.php handlers
	// ------------------------------------------------------------------

	public function handle_tier_create(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_loyalty_tier_create' );

		$result = ( new TierService() )->create(
			sanitize_key( wp_unslash( (string) ( $_POST['slug'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			sanitize_text_field( wp_unslash( (string) ( $_POST['name'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			(int) ( $_POST['threshold_points'] ?? 0 ) // phpcs:ignore WordPress.Security.NonceVerification.Missing
		);
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_tier_toggle(): void {
		$this->assert_capability();
		$id = (int) ( $_POST['tier_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_loyalty_tier_toggle_' . $id );

		$tier = ( new TierService() )->find( $id );
		if ( $tier ) {
			( new TierService() )->update( $id, [ 'isActive' => ! $tier['isActive'] ] );
		}
		$this->redirect_back();
	}

	public function handle_plan_create(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_loyalty_plan_create' );

		$result = ( new MembershipService() )->create_plan(
			sanitize_key( wp_unslash( (string) ( $_POST['slug'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			sanitize_text_field( wp_unslash( (string) ( $_POST['name'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			! empty( $_POST['tier_id'] ) ? (int) $_POST['tier_id'] : null, // phpcs:ignore WordPress.Security.NonceVerification.Missing
			! empty( $_POST['is_paid'] ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			isset( $_POST['price'] ) && '' !== $_POST['price'] ? (int) $_POST['price'] : null, // phpcs:ignore WordPress.Security.NonceVerification.Missing
			null
		);
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_plan_toggle(): void {
		$this->assert_capability();
		$id = (int) ( $_POST['plan_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_loyalty_plan_toggle_' . $id );

		$plan = ( new MembershipService() )->find_plan( $id );
		if ( $plan ) {
			( new MembershipService() )->update_plan( $id, [ 'isActive' => ! $plan['isActive'] ] );
		}
		$this->redirect_back();
	}

	public function handle_benefit_create(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_loyalty_benefit_create' );

		$type   = sanitize_key( wp_unslash( (string) ( $_POST['benefit_type'] ?? '' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$value  = isset( $_POST['value'] ) && '' !== $_POST['value'] ? (float) $_POST['value'] : null; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$config = [];
		if ( BenefitService::TYPE_BONUS_POINTS_MULTIPLIER === $type && null !== $value ) {
			$config['multiplier'] = $value;
		} elseif ( BenefitService::TYPE_DISCOUNT_PERCENTAGE === $type && null !== $value ) {
			$config['percentage'] = $value;
		}

		$result = ( new BenefitService() )->create(
			sanitize_key( wp_unslash( (string) ( $_POST['source_type'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			(int) ( $_POST['source_id'] ?? 0 ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			$type,
			sanitize_text_field( wp_unslash( (string) ( $_POST['label'] ?? '' ) ) ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			$config
		);
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_benefit_delete(): void {
		$this->assert_capability();
		$id = (int) ( $_POST['benefit_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_loyalty_benefit_delete_' . $id );

		( new BenefitService() )->delete( $id );
		$this->redirect_back();
	}

	public function handle_membership_grant(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_loyalty_membership_grant' );

		$email = sanitize_email( wp_unslash( (string) ( $_POST['email'] ?? '' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$user  = get_user_by( 'email', $email );
		if ( ! $user ) {
			$this->redirect_back( 'کاربری با این ایمیل پیدا نشد.' );
			return;
		}

		$plan_id = (int) ( $_POST['plan_id'] ?? 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$result  = ( new MembershipService() )->activate( $user->ID, $plan_id, 'manual', get_current_user_id() );
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	public function handle_membership_cancel(): void {
		$this->assert_capability();
		check_admin_referer( 'bc_loyalty_membership_cancel' );

		$email = sanitize_email( wp_unslash( (string) ( $_POST['email'] ?? '' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$user  = get_user_by( 'email', $email );
		if ( ! $user ) {
			$this->redirect_back( 'کاربری با این ایمیل پیدا نشد.' );
			return;
		}

		$result = ( new MembershipService() )->cancel( $user->ID, get_current_user_id() );
		$this->redirect_back( is_string( $result ) ? $result : null );
	}

	private function assert_capability(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-loyalty' ), 403 );
		}
	}

	private function redirect_back( ?string $error = null ): void {
		$url = admin_url( 'admin.php?page=' . self::SLUG . ( $error ? '&bc_error=' . rawurlencode( $error ) : '&bc_notice=1' ) );
		wp_safe_redirect( $url );
		exit;
	}
}
