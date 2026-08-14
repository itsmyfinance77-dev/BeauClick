<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Admin;

use BeauClick\Core\Admin\Shell\AdminShell;
use BeauClick\Reviews\Reviews\ReviewService;

/**
 * V2.2 Step 13: moderation decisions now also write to the general admin
 * audit log (ADMIN-02) — see moderate_and_log(), a small, directly
 * testable method separated from the admin-post.php handler (which ends in
 * wp_safe_redirect()+exit).
 */
final class ReviewsAdminPage {

	private const STATUS_LABELS = [
		'pending'  => 'در انتظار',
		'approved' => 'تأیید‌شده',
		'rejected' => 'رد‌شده',
		'flagged'  => 'پرچم‌گذاری‌شده',
	];

	/** Hook priority (not add_submenu_page()'s own $position argument — see BeauClick\Core\Admin\OperationsHealthPage::register()'s docblock) is what places this menu in the intended BeauClick admin order. */
	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ], 11 );
		add_action( 'admin_post_bc_review_moderate', [ $this, 'handle_moderate' ] );
	}

	public function add_page(): void {
		add_submenu_page(
			'beauclick',
			__( 'بازبینی نظرات', 'beauclick-reviews' ),
			__( 'بازبینی نظرات', 'beauclick-reviews' ),
			'bc_moderate_reviews',
			'beauclick-reviews-moderation',
			[ $this, 'render' ]
		);
	}

	public function render(): void {
		$reviews = ( new ReviewService() )->all();

		AdminShell::header(
			__( 'بازبینی نظرات', 'beauclick-reviews' ),
			null,
			[ [ 'label' => __( 'بازبینی نظرات', 'beauclick-reviews' ) ] ]
		);

		if ( isset( $_GET['bc_notice'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			AdminShell::notice( __( 'انجام شد.', 'beauclick-reviews' ) );
		}

		if ( ! $reviews ) {
			AdminShell::empty_state( __( 'هیچ نظری ثبت نشده است.', 'beauclick-reviews' ) );
			AdminShell::footer();
			return;
		}

		AdminShell::table_open();
		echo '<table class="wp-list-table widefat fixed striped">';
		echo '<thead><tr>';
		echo '<th>' . esc_html__( 'نویسنده', 'beauclick-reviews' ) . '</th>';
		echo '<th>' . esc_html__( 'امتیاز', 'beauclick-reviews' ) . '</th>';
		echo '<th>' . esc_html__( 'متن', 'beauclick-reviews' ) . '</th>';
		echo '<th>' . esc_html__( 'وضعیت', 'beauclick-reviews' ) . '</th>';
		echo '<th>' . esc_html__( 'عملیات', 'beauclick-reviews' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $reviews as $review ) {
			echo '<tr>';
			echo '<td>' . esc_html( $review['authorName'] ) . '</td>';
			echo '<td class="bc-numeric">' . esc_html( (string) $review['rating'] ) . '</td>';
			echo '<td>' . esc_html( wp_trim_words( (string) $review['body'], 20 ) ) . '</td>';
			echo '<td>' . esc_html( self::STATUS_LABELS[ $review['status'] ] ?? $review['status'] ) . '</td>';
			echo '<td>';
			foreach ( [ 'approved', 'rejected', 'flagged' ] as $target_status ) {
				if ( $target_status === $review['status'] ) {
					continue;
				}
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline;">';
				wp_nonce_field( 'bc_review_moderate_' . $review['id'] );
				echo '<input type="hidden" name="action" value="bc_review_moderate">';
				echo '<input type="hidden" name="review_id" value="' . esc_attr( $review['id'] ) . '">';
				echo '<input type="hidden" name="status" value="' . esc_attr( $target_status ) . '">';
				echo '<button type="submit" class="button">' . esc_html( self::STATUS_LABELS[ $target_status ] ) . '</button></form> ';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
		AdminShell::table_close();
		AdminShell::footer();
	}

	public function handle_moderate(): void {
		if ( ! current_user_can( 'bc_moderate_reviews' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-reviews' ), 403 );
		}

		$review_id = isset( $_POST['review_id'] ) ? (int) $_POST['review_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_review_moderate_' . $review_id );

		$status = isset( $_POST['status'] ) ? sanitize_key( wp_unslash( $_POST['status'] ) ) : '';
		$this->moderate_and_log( $review_id, $status );

		wp_safe_redirect( admin_url( 'admin.php?page=beauclick-reviews-moderation&bc_notice=1' ) );
		exit;
	}

	public function moderate_and_log( int $review_id, string $status ): void {
		$before = ( new ReviewService() )->find( $review_id );
		( new ReviewService() )->moderate( $review_id, $status );
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->audit_log()->record(
				'review_moderated',
				'review',
				$review_id,
				get_current_user_id(),
				$before ? [ 'status' => $before['status'] ] : null,
				[ 'status' => $status ]
			);
		}
	}
}
