<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Core\Support\JalaliDate;
use BeauClick\Marketplace\Verification\VerificationService;

/**
 * V2.1 Step 8 — the real admin review workflow, replacing the raw
 * VerificationMetaBox dropdown (now read-only, see that class) as the
 * only way a status actually changes. Deliberately a real, purpose-built
 * page under the existing `beauclick` admin menu (AdminMenu's own parent
 * slug, same convention ReviewsAdminPage/AccountsAdminPage already use) —
 * "design thoughtfully rather than copying raw WordPress metaboxes
 * everywhere" per the task's own instruction — not a second React SPA
 * mounted into wp-admin, which this project's admin surface has never
 * done anywhere else.
 *
 * Gated on `bc_moderate_verification` (RoleManager's own previously-unused
 * capability, already granted to the moderator role and, by extension,
 * every administrator) rather than `bc_manage_platform` — same
 * "determine the appropriate capability" instruction VerificationController
 * already follows on the REST side.
 */
final class VerificationReviewPage {

	private const SLUG = 'beauclick-verification';

	/** Hook priority (not add_submenu_page()'s own $position argument — see BeauClick\Core\Admin\OperationsHealthPage::register()'s docblock) is what places this menu right after core's own Overview/Operations/Audit Log/Users. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 9 );
		add_action( 'admin_post_bc_verification_decide', [ $this, 'handle_decide' ] );
		add_action( 'admin_post_bc_verification_status_action', [ $this, 'handle_status_action' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'تأیید متخصصان', 'beauclick-marketplace' ),
			__( 'تأیید متخصصان', 'beauclick-marketplace' ),
			'bc_moderate_verification',
			self::SLUG,
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'bc_moderate_verification' ) ) {
			wp_die( esc_html__( 'شما اجازه دسترسی به این بخش را ندارید.', 'beauclick-marketplace' ), 403 );
		}

		$request_id = isset( $_GET['request_id'] ) ? (int) $_GET['request_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

		AdminShell::header(
			__( 'تأیید متخصصان و کسب‌وکارها', 'beauclick-marketplace' ),
			null,
			[ [ 'label' => __( 'تأیید متخصصان', 'beauclick-marketplace' ) ] ]
		);

		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'با موفقیت ثبت شد.', 'beauclick-marketplace' ) );
		}

		if ( $request_id ) {
			$this->render_request_detail( $request_id );
		} else {
			$this->render_queue();
			$this->render_verified_providers_panel();
		}

		AdminShell::footer();
	}

	private function render_queue(): void {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}bc_verification_requests WHERE status = 'pending' ORDER BY submitted_at ASC" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		echo '<h2>' . esc_html__( 'درخواست‌های در انتظار بررسی', 'beauclick-marketplace' ) . '</h2>';
		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'متخصص/کسب‌وکار', 'beauclick-marketplace' ) . '</th>';
		echo '<th>' . esc_html__( 'نوع', 'beauclick-marketplace' ) . '</th>';
		echo '<th>' . esc_html__( 'تاریخ ثبت درخواست', 'beauclick-marketplace' ) . '</th>';
		echo '<th></th></tr></thead><tbody>';

		if ( ! $rows ) {
			echo '<tr><td colspan="4">' . esc_html__( 'در حال حاضر درخواستی برای بررسی وجود ندارد.', 'beauclick-marketplace' ) . '</td></tr>';
		}

		foreach ( $rows as $row ) {
			$provider = get_post( (int) $row->provider_id );
			echo '<tr>';
			echo '<td>' . esc_html( $provider ? $provider->post_title : '' ) . '</td>';
			echo '<td>' . esc_html( $provider && 'bc_business' === $provider->post_type ? 'کسب‌وکار' : 'متخصص' ) . '</td>';
			echo '<td>' . esc_html( JalaliDate::format( $row->submitted_at, true ) ) . '</td>';
			echo '<td><a class="button button-primary" href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG . '&request_id=' . $row->id ) ) . '">' . esc_html__( 'بررسی', 'beauclick-marketplace' ) . '</a></td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_request_detail( int $request_id ): void {
		global $wpdb;
		$request = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_verification_requests WHERE id = %d", $request_id ) );

		if ( ! $request ) {
			echo '<p>' . esc_html__( 'این درخواست پیدا نشد.', 'beauclick-marketplace' ) . '</p>';
			return;
		}

		$provider = get_post( (int) $request->provider_id );
		$evidence = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_verification_evidence WHERE request_id = %d", $request_id ) );
		$service  = new VerificationService();
		$history  = $service->summary( (int) $request->provider_id )['history'];
		$nonce    = wp_create_nonce( 'wp_rest' ); // Appended to evidence links -- a plain wp-admin hyperlink to a REST GET route still needs this; the REST cookie-auth layer requires it for any request, not just state-changing ones.

		echo '<p><a href="' . esc_url( admin_url( 'admin.php?page=' . self::SLUG ) ) . '">&larr; ' . esc_html__( 'بازگشت به فهرست', 'beauclick-marketplace' ) . '</a></p>';
		echo '<h2>' . esc_html( $provider ? $provider->post_title : '' ) . '</h2>';
		echo '<p><strong>' . esc_html__( 'وضعیت فعلی:', 'beauclick-marketplace' ) . '</strong> ' . esc_html( self::status_label( $service->current_status( (int) $request->provider_id ) ) ) . '</p>';
		echo '<p><strong>' . esc_html__( 'تاریخ ثبت درخواست:', 'beauclick-marketplace' ) . '</strong> ' . esc_html( JalaliDate::format( $request->submitted_at, true ) ) . '</p>';

		echo '<h3>' . esc_html__( 'مدارک ارسالی', 'beauclick-marketplace' ) . '</h3>';
		if ( ! $evidence ) {
			echo '<p>' . esc_html__( 'مدرکی ثبت نشده است.', 'beauclick-marketplace' ) . '</p>';
		} else {
			echo '<ul>';
			foreach ( $evidence as $e ) {
				$url = rest_url( 'beauclick/v1/marketplace/verification/evidence/' . $e->id ) . '?_wpnonce=' . $nonce;
				echo '<li><a href="' . esc_url( $url ) . '" target="_blank" rel="noopener">' . esc_html( self::evidence_type_label( $e->evidence_type ) . ' — ' . $e->original_filename ) . '</a></li>';
			}
			echo '</ul>';
		}

		if ( 'pending' === $request->status ) {
			echo '<h3>' . esc_html__( 'تصمیم', 'beauclick-marketplace' ) . '</h3>';
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			wp_nonce_field( 'bc_verification_decide_' . $request_id );
			echo '<input type="hidden" name="action" value="bc_verification_decide">';
			echo '<input type="hidden" name="request_id" value="' . esc_attr( (string) $request_id ) . '">';
			echo '<p><textarea name="reason" rows="3" style="width:100%;max-width:480px;" placeholder="' . esc_attr__( 'دلیل (برای رد درخواست الزامی است)', 'beauclick-marketplace' ) . '"></textarea></p>';
			echo '<button type="submit" name="decision" value="verified" class="button button-primary">' . esc_html__( 'تأیید', 'beauclick-marketplace' ) . '</button> ';
			echo '<button type="submit" name="decision" value="rejected" class="button">' . esc_html__( 'رد درخواست', 'beauclick-marketplace' ) . '</button>';
			echo '</form>';
		} else {
			echo '<p><em>' . esc_html__( 'این درخواست قبلاً بررسی شده است.', 'beauclick-marketplace' ) . '</em></p>';
		}

		$this->render_status_actions( (int) $request->provider_id, $service->current_status( (int) $request->provider_id ) );

		echo '<h3>' . esc_html__( 'تاریخچه تأیید', 'beauclick-marketplace' ) . '</h3>';
		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr><th>' . esc_html__( 'از', 'beauclick-marketplace' ) . '</th><th>' . esc_html__( 'به', 'beauclick-marketplace' ) . '</th><th>' . esc_html__( 'تاریخ', 'beauclick-marketplace' ) . '</th><th>' . esc_html__( 'دلیل', 'beauclick-marketplace' ) . '</th></tr></thead><tbody>';
		foreach ( $history as $h ) {
			echo '<tr><td>' . esc_html( self::status_label( $h['fromStatus'] ) ) . '</td><td>' . esc_html( self::status_label( $h['toStatus'] ) ) . '</td><td>' . esc_html( JalaliDate::format( $h['createdAt'], true ) ) . '</td><td>' . esc_html( $h['reason'] ?? '' ) . '</td></tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	private function render_status_actions( int $provider_id, string $current_status ): void {
		$actions = [
			'verified'  => [ 'suspend', __( 'تعلیق', 'beauclick-marketplace' ) ],
			'suspended' => [ 'reinstate', __( 'بازگرداندن تأیید', 'beauclick-marketplace' ) ],
		];
		$revoke_from = [ 'verified', 'suspended' ];

		if ( ! isset( $actions[ $current_status ] ) && ! in_array( $current_status, $revoke_from, true ) ) {
			return;
		}

		echo '<h3>' . esc_html__( 'مدیریت وضعیت تأیید', 'beauclick-marketplace' ) . '</h3>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'bc_verification_status_' . $provider_id );
		echo '<input type="hidden" name="action" value="bc_verification_status_action">';
		echo '<input type="hidden" name="provider_id" value="' . esc_attr( (string) $provider_id ) . '">';
		echo '<p><textarea name="reason" rows="2" style="width:100%;max-width:480px;" placeholder="' . esc_attr__( 'دلیل', 'beauclick-marketplace' ) . '"></textarea></p>';

		if ( isset( $actions[ $current_status ] ) ) {
			[ $target, $label ] = $actions[ $current_status ];
			echo '<button type="submit" name="target" value="' . esc_attr( $target ) . '" class="button">' . esc_html( $label ) . '</button> ';
		}
		if ( in_array( $current_status, $revoke_from, true ) ) {
			echo '<button type="submit" name="target" value="revoke" class="button">' . esc_html__( 'لغو تأیید (نهایی)', 'beauclick-marketplace' ) . '</button>';
		}
		echo '</form>';
	}

	private function render_verified_providers_panel(): void {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT ID, post_title, post_type FROM {$wpdb->prefix}posts WHERE post_type IN ('bc_professional','bc_business') AND post_status = 'publish' AND ID IN (SELECT post_id FROM {$wpdb->prefix}postmeta WHERE meta_key = '_bc_verification_status' AND meta_value IN ('verified','suspended'))" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		echo '<h2 style="margin-top:32px;">' . esc_html__( 'متخصصان تأییدشده', 'beauclick-marketplace' ) . '</h2>';
		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped"><thead><tr><th>' . esc_html__( 'نام', 'beauclick-marketplace' ) . '</th><th>' . esc_html__( 'وضعیت', 'beauclick-marketplace' ) . '</th><th></th></tr></thead><tbody>';
		if ( ! $rows ) {
			echo '<tr><td colspan="3">' . esc_html__( 'موردی وجود ندارد.', 'beauclick-marketplace' ) . '</td></tr>';
		}
		foreach ( $rows as $row ) {
			$status = get_post_meta( (int) $row->ID, '_bc_verification_status', true );
			echo '<tr><td>' . esc_html( $row->post_title ) . '</td><td>' . esc_html( self::status_label( $status ) ) . '</td>';
			echo '<td>';
			$this->render_status_actions( (int) $row->ID, $status );
			echo '</td></tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
	}

	public function handle_decide(): void {
		if ( ! current_user_can( 'bc_moderate_verification' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-marketplace' ), 403 );
		}
		$request_id = isset( $_POST['request_id'] ) ? (int) $_POST['request_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_verification_decide_' . $request_id );

		$decision = isset( $_POST['decision'] ) ? sanitize_key( wp_unslash( $_POST['decision'] ) ) : '';
		$reason   = isset( $_POST['reason'] ) ? sanitize_textarea_field( wp_unslash( $_POST['reason'] ) ) : '';

		( new VerificationService() )->decide( $request_id, get_current_user_id(), $decision, $reason );

		wp_safe_redirect( admin_url( 'admin.php?page=' . self::SLUG . '&bc_notice=1' ) );
		exit;
	}

	public function handle_status_action(): void {
		if ( ! current_user_can( 'bc_moderate_verification' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-marketplace' ), 403 );
		}
		$provider_id = isset( $_POST['provider_id'] ) ? (int) $_POST['provider_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_verification_status_' . $provider_id );

		$target = isset( $_POST['target'] ) ? sanitize_key( wp_unslash( $_POST['target'] ) ) : '';
		$reason = isset( $_POST['reason'] ) ? sanitize_textarea_field( wp_unslash( $_POST['reason'] ) ) : '';

		$service = new VerificationService();
		match ( $target ) {
			'suspend'   => $service->suspend( $provider_id, get_current_user_id(), $reason ),
			'reinstate' => $service->reinstate( $provider_id, get_current_user_id(), $reason ),
			'revoke'    => $service->revoke( $provider_id, get_current_user_id(), $reason ),
			default     => null,
		};

		wp_safe_redirect( admin_url( 'admin.php?page=' . self::SLUG . '&bc_notice=1' ) );
		exit;
	}

	public static function status_label( string $status ): string {
		return match ( $status ) {
			'unverified' => __( 'بدون درخواست', 'beauclick-marketplace' ),
			'pending'    => __( 'در انتظار بررسی', 'beauclick-marketplace' ),
			'verified'   => __( 'تأییدشده', 'beauclick-marketplace' ),
			'rejected'   => __( 'ردشده', 'beauclick-marketplace' ),
			'suspended'  => __( 'معلق‌شده', 'beauclick-marketplace' ),
			'revoked'    => __( 'لغوشده', 'beauclick-marketplace' ),
			default      => $status,
		};
	}

	private static function evidence_type_label( string $type ): string {
		return match ( $type ) {
			'identity'    => __( 'مدرک هویتی', 'beauclick-marketplace' ),
			'certificate' => __( 'گواهینامه', 'beauclick-marketplace' ),
			'license'     => __( 'مجوز کسب‌وکار', 'beauclick-marketplace' ),
			'portfolio'   => __( 'نمونه‌کار', 'beauclick-marketplace' ),
			default       => __( 'سایر', 'beauclick-marketplace' ),
		};
	}
}
