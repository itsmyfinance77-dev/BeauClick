<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Admin;

use BeauClick\Reviews\Reviews\ReviewService;

final class ReviewsAdminPage {

	private const STATUS_LABELS = [
		'pending'  => 'در انتظار',
		'approved' => 'تأیید‌شده',
		'rejected' => 'رد‌شده',
		'flagged'  => 'پرچم‌گذاری‌شده',
	];

	public function register(): void {
		add_action( 'admin_menu', [ $this, 'add_page' ] );
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
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'بازبینی نظرات', 'beauclick-reviews' ); ?></h1>
			<?php if ( isset( $_GET['bc_notice'] ) ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended ?>
				<div class="notice notice-success is-dismissible"><p><?php esc_html_e( 'انجام شد.', 'beauclick-reviews' ); ?></p></div>
			<?php endif; ?>
			<table class="wp-list-table widefat fixed striped">
				<thead>
					<tr>
						<th><?php esc_html_e( 'نویسنده', 'beauclick-reviews' ); ?></th>
						<th><?php esc_html_e( 'امتیاز', 'beauclick-reviews' ); ?></th>
						<th><?php esc_html_e( 'متن', 'beauclick-reviews' ); ?></th>
						<th><?php esc_html_e( 'وضعیت', 'beauclick-reviews' ); ?></th>
						<th><?php esc_html_e( 'عملیات', 'beauclick-reviews' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php if ( ! $reviews ) : ?>
						<tr><td colspan="5"><?php esc_html_e( 'هیچ نظری ثبت نشده است.', 'beauclick-reviews' ); ?></td></tr>
					<?php endif; ?>
					<?php foreach ( $reviews as $review ) : ?>
						<tr>
							<td><?php echo esc_html( $review['authorName'] ); ?></td>
							<td><?php echo esc_html( (string) $review['rating'] ); ?></td>
							<td><?php echo esc_html( wp_trim_words( (string) $review['body'], 20 ) ); ?></td>
							<td><?php echo esc_html( self::STATUS_LABELS[ $review['status'] ] ?? $review['status'] ); ?></td>
							<td>
								<?php foreach ( [ 'approved', 'rejected', 'flagged' ] as $target_status ) : ?>
									<?php if ( $target_status !== $review['status'] ) : ?>
										<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
											<?php wp_nonce_field( 'bc_review_moderate_' . $review['id'] ); ?>
											<input type="hidden" name="action" value="bc_review_moderate">
											<input type="hidden" name="review_id" value="<?php echo esc_attr( $review['id'] ); ?>">
											<input type="hidden" name="status" value="<?php echo esc_attr( $target_status ); ?>">
											<button type="submit" class="button"><?php echo esc_html( self::STATUS_LABELS[ $target_status ] ); ?></button>
										</form>
									<?php endif; ?>
								<?php endforeach; ?>
							</td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function handle_moderate(): void {
		if ( ! current_user_can( 'bc_moderate_reviews' ) ) {
			wp_die( esc_html__( 'شما اجازه این کار را ندارید.', 'beauclick-reviews' ), 403 );
		}

		$review_id = isset( $_POST['review_id'] ) ? (int) $_POST['review_id'] : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		check_admin_referer( 'bc_review_moderate_' . $review_id );

		$status = isset( $_POST['status'] ) ? sanitize_key( wp_unslash( $_POST['status'] ) ) : '';
		( new ReviewService() )->moderate( $review_id, $status );

		wp_safe_redirect( admin_url( 'admin.php?page=beauclick-reviews-moderation&bc_notice=1' ) );
		exit;
	}
}
