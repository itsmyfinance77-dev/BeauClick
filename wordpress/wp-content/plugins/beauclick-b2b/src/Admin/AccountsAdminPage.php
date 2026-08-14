<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Admin;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\Core\Admin\Shell\AdminShell;

/**
 * The REST endpoints for this (B2BController::approve_account() etc.) have
 * existed since Phase 7 with no UI ever calling them — an admin could only
 * approve a B2B application via raw HTTP. Classic wp-admin form +
 * admin-post.php rather than a React surface: this is low-frequency
 * internal tooling, not something worth a SPA build step for.
 *
 * V2.2 Step 13: approve/reject now also write to the general admin audit
 * log (ADMIN-02) — see approve_and_log()/reject_and_log(), each a small,
 * directly testable method (unlike the admin-post.php handlers themselves,
 * which end in wp_safe_redirect()+exit and are awkward to unit test) that
 * captures the account's previous/new approval_status around the existing
 * BusinessAccountService call.
 */
final class AccountsAdminPage {

	/** Hook priority (not add_submenu_page()'s own $position argument — see BeauClick\Core\Admin\OperationsHealthPage::register()'s docblock) is what places this menu in the intended BeauClick admin order. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 10 );
		add_action( 'admin_post_bc_b2b_approve', [ $this, 'handle_approve' ] );
		add_action( 'admin_post_bc_b2b_reject', [ $this, 'handle_reject' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'حساب‌های B2B', 'beauclick-b2b' ),
			__( 'حساب‌های B2B', 'beauclick-b2b' ),
			'bc_manage_platform',
			'beauclick-b2b-accounts',
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		global $wpdb;
		$accounts = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_business_accounts ORDER BY (approval_status = 'pending') DESC, created_at DESC LIMIT 100", ARRAY_A );

		AdminShell::header(
			__( 'حساب‌های B2B', 'beauclick-b2b' ),
			null,
			[ [ 'label' => __( 'حساب‌های B2B', 'beauclick-b2b' ) ] ]
		);

		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-b2b' ) );
		}

		if ( ! $accounts ) {
			AdminShell::empty_state( __( 'هیچ حسابی ثبت نشده است.', 'beauclick-b2b' ) );
			AdminShell::footer();
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped">';
		echo '<thead><tr>';
		echo '<th>' . esc_html__( 'کسب‌وکار', 'beauclick-b2b' ) . '</th>';
		echo '<th>' . esc_html__( 'تماس', 'beauclick-b2b' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-b2b' ) . '</th>';
		echo '<th>' . esc_html__( 'عملیات', 'beauclick-b2b' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $accounts as $account ) {
			echo '<tr>';
			echo '<td>' . esc_html( $account['business_name'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( $account['contact_phone'] ?? '' ) . '</td>';
			echo '<td>' . esc_html( $account['approval_status'] ) . '</td>';
			echo '<td>';
			if ( 'pending' === $account['approval_status'] ) {
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline;">';
				wp_nonce_field( 'bc_b2b_account_' . $account['id'] );
				echo '<input type="hidden" name="action" value="bc_b2b_approve">';
				echo '<input type="hidden" name="account_id" value="' . esc_attr( $account['id'] ) . '">';
				echo '<button type="submit" class="button button-primary">' . esc_html__( 'تأیید', 'beauclick-b2b' ) . '</button></form> ';
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline;">';
				wp_nonce_field( 'bc_b2b_account_' . $account['id'] );
				echo '<input type="hidden" name="action" value="bc_b2b_reject">';
				echo '<input type="hidden" name="account_id" value="' . esc_attr( $account['id'] ) . '">';
				echo '<button type="submit" class="button">' . esc_html__( 'رد', 'beauclick-b2b' ) . '</button></form>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
		AdminShell::footer();
	}

	public function handle_approve(): void {
		$account_id = $this->verified_account_id();
		$this->approve_and_log( $account_id );
		$this->redirect_back();
	}

	public function handle_reject(): void {
		$account_id = $this->verified_account_id();
		$this->reject_and_log( $account_id );
		$this->redirect_back();
	}

	public function approve_and_log( int $account_id ): void {
		$before = $this->account_row( $account_id );
		( new BusinessAccountService() )->approve( $account_id );
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record(
				'b2b_account_approved',
				'business_account',
				$account_id,
				get_current_user_id(),
				$before,
				[ 'approval_status' => BusinessAccountService::STATUS_APPROVED ]
			);
		}
	}

	public function reject_and_log( int $account_id ): void {
		$before = $this->account_row( $account_id );
		$reason = __( 'رد شده توسط مدیر', 'beauclick-b2b' );
		( new BusinessAccountService() )->reject( $account_id, $reason );
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record(
				'b2b_account_rejected',
				'business_account',
				$account_id,
				get_current_user_id(),
				$before,
				[ 'approval_status' => BusinessAccountService::STATUS_REJECTED ],
				$reason
			);
		}
	}

	/** @return array<string, mixed>|null */
	private function account_row( int $account_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT approval_status FROM {$wpdb->prefix}bc_business_accounts WHERE id = %d", $account_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return $row ?: null;
	}

	private function verified_account_id(): int {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-b2b' ), 403 );
		}
		$account_id = isset( $_POST['account_id'] ) ? (int) $_POST['account_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_b2b_account_' . $account_id );
		return $account_id;
	}

	private function redirect_back(): void {
		wp_safe_redirect( admin_url( 'admin.php?page=beauclick-b2b-accounts&bc_notice=1' ) );
		exit;
	}
}
