<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Admin;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;

/**
 * `_bc_verification_status` (the "تایید‌شده" badge shown everywhere on the
 * frontend) has driven real UI since Phase 4, but nothing has ever let an
 * admin actually change it — WordPress hides underscore-prefixed meta keys
 * from the default Custom Fields box, so this was a real dead end, not
 * just missing polish. Resyncing the search index on save is what makes a
 * status change actually show up in marketplace search results/filtering,
 * not just on the profile page.
 */
final class VerificationMetaBox {

	private const STATUSES = [
		'pending'  => 'در انتظار بررسی',
		'verified' => 'تایید‌شده',
		'rejected' => 'رد‌شده',
	];

	public function register(): void {
		add_action( 'add_meta_boxes', [ $this, 'add_box' ] );
		add_action( 'save_post_' . Registrar::PROFESSIONAL, [ $this, 'save' ] );
		add_action( 'save_post_' . Registrar::BUSINESS, [ $this, 'save' ] );
	}

	public function add_box(): void {
		foreach ( [ Registrar::PROFESSIONAL, Registrar::BUSINESS ] as $post_type ) {
			add_meta_box(
				'bc_verification',
				__( 'وضعیت تایید', 'beauclick-marketplace' ),
				[ $this, 'render' ],
				$post_type,
				'side'
			);
		}
	}

	public function render( \WP_Post $post ): void {
		$current = get_post_meta( $post->ID, '_bc_verification_status', true ) ?: 'pending';

		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			echo '<p>' . esc_html( self::STATUSES[ $current ] ?? $current ) . '</p>';
			return;
		}

		wp_nonce_field( 'bc_verification_' . $post->ID, 'bc_verification_nonce' );
		?>
		<select name="bc_verification_status" style="width:100%;">
			<?php foreach ( self::STATUSES as $value => $label ) : ?>
				<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $current, $value ); ?>><?php echo esc_html( $label ); ?></option>
			<?php endforeach; ?>
		</select>
		<?php
	}

	public function save( int $post_id ): void {
		if ( ! isset( $_POST['bc_verification_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['bc_verification_nonce'] ) ), 'bc_verification_' . $post_id ) ) {
			return;
		}
		if ( ! current_user_can( 'bc_manage_platform' ) ) {
			return;
		}
		if ( ! isset( $_POST['bc_verification_status'] ) ) {
			return;
		}

		$status = sanitize_key( wp_unslash( $_POST['bc_verification_status'] ) );
		if ( ! array_key_exists( $status, self::STATUSES ) ) {
			return;
		}

		update_post_meta( $post_id, '_bc_verification_status', $status );

		$post = get_post( $post_id );
		if ( $post ) {
			( new Indexer() )->sync( $post_id, $post->post_type );
		}
	}
}
