<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Admin;

use BeauClick\Marketplace\PostTypes\Registrar;

/**
 * `_bc_verification_status` (the "تایید‌شده" badge shown everywhere on the
 * frontend) has driven real UI since Phase 4. As of V2.1 Step 8 this box is
 * deliberately READ-ONLY: the direct-edit `<select>` + raw `update_post_meta()`
 * save this box used to perform has been removed, because it let an admin
 * bypass VerificationService's audited state machine entirely (no history
 * row, no transition validation, no reviewer/reason captured). The one and
 * only way this status now changes is VerificationReviewPage's admin-post
 * handlers, which go through VerificationService -- this box just displays
 * the result and links there.
 */
final class VerificationMetaBox {

	public function register(): void {
		add_action( 'add_meta_boxes', [ $this, 'add_box' ] );
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
		$current = get_post_meta( $post->ID, '_bc_verification_status', true ) ?: 'unverified';

		echo '<p>' . esc_html( VerificationReviewPage::status_label( $current ) ) . '</p>';
		echo '<p><a href="' . esc_url( admin_url( 'admin.php?page=beauclick-verification' ) ) . '">' . esc_html__( 'مدیریت در صفحه تأیید متخصصان', 'beauclick-marketplace' ) . '</a></p>';
	}
}
