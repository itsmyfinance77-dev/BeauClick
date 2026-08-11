<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Admin;

use BeauClick\B2B\Business\BusinessAccountService;

/**
 * The REST endpoints for this (B2BController::approve_account() etc.) have
 * existed since Phase 7 with no UI ever calling them — an admin could only
 * approve a B2B application via raw HTTP. Classic wp-admin form +
 * admin-post.php rather than a React surface: this is low-frequency
 * internal tooling, not something worth a SPA build step for.
 */
final class AccountsAdminPage {

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ] );
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
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'حساب‌های B2B', 'beauclick-b2b' ); ?></h1>
			<?php if ( isset( $_GET['bc_notice'] ) ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended ?>
				<div class="notice notice-success is-dismissible"><p><?php esc_html_e( 'انجام شد.', 'beauclick-b2b' ); ?></p></div>
			<?php endif; ?>
			<table class="wp-list-table widefat fixed striped">
				<thead>
					<tr>
						<th><?php esc_html_e( 'کسب‌وکار', 'beauclick-b2b' ); ?></th>
						<th><?php esc_html_e( 'تماس', 'beauclick-b2b' ); ?></th>
						<th><?php esc_html_e( 'وضعیت', 'beauclick-b2b' ); ?></th>
						<th><?php esc_html_e( 'عملیات', 'beauclick-b2b' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php if ( ! $accounts ) : ?>
						<tr><td colspan="4"><?php esc_html_e( 'هیچ حسابی ثبت نشده است.', 'beauclick-b2b' ); ?></td></tr>
					<?php endif; ?>
					<?php foreach ( $accounts as $account ) : ?>
						<tr>
							<td><?php echo esc_html( $account['business_name'] ); ?></td>
							<td><?php echo esc_html( $account['contact_phone'] ?? '' ); ?></td>
							<td><?php echo esc_html( $account['approval_status'] ); ?></td>
							<td>
								<?php if ( 'pending' === $account['approval_status'] ) : ?>
									<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
										<?php wp_nonce_field( 'bc_b2b_account_' . $account['id'] ); ?>
										<input type="hidden" name="action" value="bc_b2b_approve">
										<input type="hidden" name="account_id" value="<?php echo esc_attr( $account['id'] ); ?>">
										<button type="submit" class="button button-primary"><?php esc_html_e( 'تأیید', 'beauclick-b2b' ); ?></button>
									</form>
									<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
										<?php wp_nonce_field( 'bc_b2b_account_' . $account['id'] ); ?>
										<input type="hidden" name="action" value="bc_b2b_reject">
										<input type="hidden" name="account_id" value="<?php echo esc_attr( $account['id'] ); ?>">
										<button type="submit" class="button"><?php esc_html_e( 'رد', 'beauclick-b2b' ); ?></button>
									</form>
								<?php endif; ?>
							</td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function handle_approve(): void {
		$account_id = $this->verified_account_id();
		( new BusinessAccountService() )->approve( $account_id );
		$this->redirect_back();
	}

	public function handle_reject(): void {
		$account_id = $this->verified_account_id();
		( new BusinessAccountService() )->reject( $account_id, __( 'رد شده توسط مدیر', 'beauclick-b2b' ) );
		$this->redirect_back();
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
