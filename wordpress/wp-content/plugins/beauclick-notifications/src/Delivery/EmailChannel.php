<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Delivery;

/**
 * wp_mail() only -- the same real transactional-email mechanism
 * `BookingMailer` already uses (§10's explicit "do not create a second
 * unrelated email system" instruction). No new SMTP/mail infrastructure;
 * delivery still depends on the environment having a working transport,
 * same caveat BookingMailer's own docblock already documents.
 */
final class EmailChannel {

	/** @return array{recipient:?string, success:bool, error:?string} */
	public function send( int $user_id, string $subject, string $body ): array {
		$user = get_userdata( $user_id );
		if ( ! $user || ! is_email( $user->user_email ) ) {
			return [ 'recipient' => null, 'success' => false, 'error' => 'no_email' ];
		}

		$sent = wp_mail( $user->user_email, $subject, $body );

		return [
			'recipient' => $user->user_email,
			'success'   => (bool) $sent,
			'error'     => $sent ? null : 'wp_mail_failed',
		];
	}
}
