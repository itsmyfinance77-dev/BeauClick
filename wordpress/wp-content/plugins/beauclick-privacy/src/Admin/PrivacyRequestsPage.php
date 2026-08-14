<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Deletion\DeletionService;

/**
 * V2.2 Step 14 — the admin review queue the architecture plan's own
 * "admin-reviewed, not instant, irreversible self-execution" design
 * decision requires. Same queue → detail → decide/reason → history shape
 * VerificationReviewPage (V2.1 Step 8) already established, gated on the
 * same `bc_manage_platform` capability every other BeauClick Step 13
 * operational page already uses (no new capability introduced).
 *
 * Export requests are shown here for operational visibility ONLY (status,
 * timestamps) — deliberately no download action for an admin (§22: an
 * admin must not be able to casually inspect another user's exported
 * personal data). Only the customer who requested it can ever download it.
 */
final class PrivacyRequestsPage {

	private const SLUG = 'beauclick-privacy-requests';

	private const STATUS_LABELS = [
		'pending'    => 'در انتظار بررسی',
		'approved'   => 'تأییدشده — در صف پردازش',
		'processing' => 'در حال پردازش',
		'completed'  => 'انجام‌شده',
		'rejected'   => 'ردشده',
		'blocked'    => 'مسدودشده',
		'cancelled'  => 'لغوشده توسط کاربر',
		'ready'      => 'آماده دانلود',
		'expired'    => 'منقضی‌شده',
		'failed'     => 'ناموفق',
	];

	/** Priority 16 — appended after every existing V2.2 Step 13 BeauClick admin page rather than renumbering their already-shipped, already-tested hook priorities (see OperationsHealthPage::register()'s own docblock for why priority, not add_submenu_page()'s $position argument, controls ordering here). */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 16 );
		add_action( 'admin_post_bc_privacy_deletion_approve', [ $this, 'handle_approve' ] );
		add_action( 'admin_post_bc_privacy_deletion_reject', [ $this, 'handle_reject' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'درخواست‌های حریم خصوصی', 'beauclick-privacy' ),
			__( 'حریم خصوصی', 'beauclick-privacy' ),
			'bc_manage_platform',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-privacy' ), 403 );
		}

		AdminShell::header(
			__( 'درخواست‌های حریم خصوصی', 'beauclick-privacy' ),
			__( 'درخواست‌های حذف حساب نیازمند بررسی و تأیید مدیر هستند. درخواست‌های دریافت اطلاعات فقط برای اطلاع نمایش داده می‌شوند — محتوای آن‌ها فقط برای خود کاربر قابل دانلود است.', 'beauclick-privacy' ),
			[ [ 'label' => __( 'حریم خصوصی', 'beauclick-privacy' ) ] ]
		);

		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-privacy' ) );
		}
		if ( isset( $_GET['bc_error'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( sanitize_text_field( wp_unslash( (string) $_GET['bc_error'] ) ), 'error' ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}

		$request_id = isset( $_GET['request_id'] ) ? (int) $_GET['request_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( $request_id ) {
			$this->render_detail( $request_id );
		} else {
			$this->render_deletion_queue();
			$this->render_deletion_history();
			$this->render_export_overview();
		}

		AdminShell::footer();
	}

	private function render_deletion_queue(): void {
		$rows = ( new DataRequestService() )->queue( DataRequestService::TYPE_DELETION, [ DataRequestService::STATUS_PENDING ] );

		echo '<h2>' . esc_html__( 'درخواست‌های حذف در انتظار بررسی', 'beauclick-privacy' ) . '</h2>';

		if ( ! $rows ) {
			AdminShell::empty_state( __( 'در حال حاضر درخواستی برای بررسی وجود ندارد.', 'beauclick-privacy' ) );
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'کاربر', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'تاریخ درخواست', 'beauclick-privacy' ) . '</th>';
		echo '<th></th></tr></thead><tbody>';
		foreach ( $rows as $row ) {
			$user = get_userdata( (int) $row['user_id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $user ? $user->display_name : ( '#' . $row['user_id'] ) ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['requested_at'], true ) ) . '</td>';
			echo '<td><a class="button button-primary" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG . '&request_id=' . $row['id'] ) ) . '">' . esc_html__( 'بررسی', 'beauclick-privacy' ) . '</a></td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_deletion_history(): void {
		$rows = ( new DataRequestService() )->queue(
			DataRequestService::TYPE_DELETION,
			[ DataRequestService::STATUS_APPROVED, DataRequestService::STATUS_PROCESSING, DataRequestService::STATUS_BLOCKED, DataRequestService::STATUS_COMPLETED, DataRequestService::STATUS_REJECTED, DataRequestService::STATUS_CANCELLED ]
		);

		echo '<h2 style="margin-top:32px;">' . esc_html__( 'سایر درخواست‌های حذف', 'beauclick-privacy' ) . '</h2>';
		if ( ! $rows ) {
			AdminShell::empty_state( __( 'موردی وجود ندارد.', 'beauclick-privacy' ) );
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'کاربر', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'دلیل / یادداشت', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'تاریخ درخواست', 'beauclick-privacy' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( array_slice( $rows, 0, 50 ) as $row ) {
			$user = get_userdata( (int) $row['user_id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $user ? $user->display_name : ( '#' . $row['user_id'] ) ) . '</td>';
			echo '<td>' . esc_html( self::STATUS_LABELS[ $row['status'] ] ?? $row['status'] ) . '</td>';
			echo '<td>' . esc_html( $row['reason'] ?: '—' ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['requested_at'], true ) ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_export_overview(): void {
		$rows = ( new DataRequestService() )->queue(
			DataRequestService::TYPE_EXPORT,
			[ DataRequestService::STATUS_READY, DataRequestService::STATUS_EXPIRED, DataRequestService::STATUS_FAILED, 'pending' ]
		);

		echo '<h2 style="margin-top:32px;">' . esc_html__( 'درخواست‌های دریافت اطلاعات (فقط اطلاع‌رسانی)', 'beauclick-privacy' ) . '</h2>';
		if ( ! $rows ) {
			AdminShell::empty_state( __( 'موردی وجود ندارد.', 'beauclick-privacy' ) );
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'کاربر', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-privacy' ) . '</th>';
		echo '<th>' . esc_html__( 'تاریخ درخواست', 'beauclick-privacy' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( array_slice( $rows, 0, 50 ) as $row ) {
			$user = get_userdata( (int) $row['user_id'] );
			echo '<tr>';
			echo '<td>' . esc_html( $user ? $user->display_name : ( '#' . $row['user_id'] ) ) . '</td>';
			echo '<td>' . esc_html( self::STATUS_LABELS[ $row['status'] ] ?? $row['status'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( JalaliDate::format( $row['requested_at'], true ) ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_detail( int $request_id ): void {
		$row = ( new DataRequestService() )->find( $request_id );
		echo '<p><a href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ) . '">&larr; ' . esc_html__( 'بازگشت به فهرست', 'beauclick-privacy' ) . '</a></p>';

		if ( ! $row || DataRequestService::TYPE_DELETION !== $row['request_type'] ) {
			echo '<p>' . esc_html__( 'این درخواست پیدا نشد.', 'beauclick-privacy' ) . '</p>';
			return;
		}

		$user = get_userdata( (int) $row['user_id'] );
		echo '<h2>' . esc_html( $user ? $user->display_name : ( '#' . $row['user_id'] ) ) . '</h2>';
		echo '<p><strong>' . esc_html__( 'وضعیت:', 'beauclick-privacy' ) . '</strong> ' . esc_html( self::STATUS_LABELS[ $row['status'] ] ?? $row['status'] ) . '</p>';
		echo '<p><strong>' . esc_html__( 'تاریخ درخواست:', 'beauclick-privacy' ) . '</strong> ' . esc_html( JalaliDate::format( $row['requested_at'], true ) ) . '</p>';

		$reasons = ( new DeletionService() )->blocking_reasons( (int) $row['user_id'] );
		if ( $reasons ) {
			echo '<div class="notice notice-warning inline"><p><strong>' . esc_html__( 'این حساب در حال حاضر شرایط حذف را ندارد:', 'beauclick-privacy' ) . '</strong></p><ul style="list-style:disc;padding-inline-start:20px;">';
			foreach ( $reasons as $reason ) {
				echo '<li>' . esc_html( $reason ) . '</li>';
			}
			echo '</ul></div>';
		}

		if ( DataRequestService::STATUS_PENDING === $row['status'] ) {
			echo '<h3>' . esc_html__( 'تصمیم', 'beauclick-privacy' ) . '</h3>';
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'bc_privacy_deletion_decide_' . $request_id );
			echo '<input type="hidden" name="request_id" value="' . esc_attr( (string) $request_id ) . '">';
			echo '<p><textarea name="reason" rows="3" style="width:100%;max-width:480px;" placeholder="' . esc_attr__( 'دلیل (برای رد درخواست الزامی است)', 'beauclick-privacy' ) . '"></textarea></p>';
			echo '<button type="submit" formaction="' . esc_url( admin_url( 'admin-post.php?action=bc_privacy_deletion_approve' ) ) . '" class="button button-primary"' . ( $reasons ? ' disabled' : '' ) . '>' . esc_html__( 'تأیید حذف', 'beauclick-privacy' ) . '</button> ';
			echo '<button type="submit" formaction="' . esc_url( admin_url( 'admin-post.php?action=bc_privacy_deletion_reject' ) ) . '" class="button">' . esc_html__( 'رد درخواست', 'beauclick-privacy' ) . '</button>';
			echo '</form>';
		} else {
			echo '<p><em>' . esc_html__( 'این درخواست قبلاً بررسی یا پردازش شده است.', 'beauclick-privacy' ) . '</em></p>';
			if ( ! empty( $row['reason'] ) ) {
				echo '<p><strong>' . esc_html__( 'دلیل / یادداشت:', 'beauclick-privacy' ) . '</strong> ' . esc_html( $row['reason'] ) . '</p>';
			}
		}
	}

	public function handle_approve(): void {
		[ $request_id, $reason ] = $this->verified_post_data();
		if ( ! ( new DeletionService() )->approve( $request_id, get_current_user_id() ) ) {
			$this->redirect_back( $request_id, 'خطا: این حساب در حال حاضر شرایط حذف را ندارد یا وضعیت درخواست تغییر کرده است.' );
			return;
		}
		$this->redirect_to_list();
	}

	public function handle_reject(): void {
		[ $request_id, $reason ] = $this->verified_post_data();
		if ( '' === trim( (string) $reason ) ) {
			$this->redirect_back( $request_id, 'برای رد درخواست، ذکر دلیل الزامی است.' );
			return;
		}
		( new DeletionService() )->reject( $request_id, get_current_user_id(), sanitize_textarea_field( (string) $reason ) );
		$this->redirect_to_list();
	}

	/** @return array{0:int,1:string} */
	private function verified_post_data(): array {
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-privacy' ), 403 );
		}
		$request_id = isset( $_POST['request_id'] ) ? (int) $_POST['request_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_privacy_deletion_decide_' . $request_id );
		$reason = isset( $_POST['reason'] ) ? sanitize_textarea_field( wp_unslash( (string) $_POST['reason'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		return [ $request_id, $reason ];
	}

	private function redirect_to_list(): void {
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::SLUG . '&bc_notice=1' ) );
		exit;
	}

	private function redirect_back( int $request_id, string $error ): void {
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::SLUG . '&request_id=' . $request_id . '&bc_error=' . rawurlencode( $error ) ) );
		exit;
	}
}
