<?php
declare( strict_types=1 );

namespace BeauClick\Reviews\Notifications;

/**
 * Same real-wp_mail(), same local-dev-transport caveat as beauclick-
 * booking's BookingMailer — see that class's docblock.
 */
final class ReviewMailer {

	public function send_new_review( array $review ): void {
		$owner_id = (int) get_post_field( 'post_author', $review['targetId'] );
		$owner    = get_userdata( $owner_id );
		if ( ! $owner || ! is_email( $owner->user_email ) ) {
			return;
		}

		$stars = str_repeat( '★', $review['rating'] ) . str_repeat( '☆', 5 - $review['rating'] );

		wp_mail(
			$owner->user_email,
			__( 'نظر جدید دریافت کردید — BeauClick', 'beauclick-reviews' ),
			sprintf(
				/* translators: 1: professional name, 2: stars, 3: review author name */
				__( "سلام %1\$s،\n\nیک نظر جدید (%2\$s) از طرف %3\$s برای شما ثبت شد.\n\nBeauClick", 'beauclick-reviews' ),
				$owner->display_name,
				$stars,
				$review['authorName']
			)
		);
	}
}
