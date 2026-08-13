<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Listeners;

use BeauClick\Referral\ReferralService;

/**
 * Reacts to beauclick-auth's `beauclick/auth/account_registered` action
 * (the extension seam this step added to AuthController::verify_otp()) —
 * beauclick-referral never reaches into beauclick-auth directly, matching
 * this codebase's existing cross-plugin communication convention
 * (beauclick/booking/completed, beauclick/payments/shop_order_completed).
 */
final class AttributionListener {

	public function register(): void {
		add_action( 'beauclick/auth/account_registered', [ $this, 'on_account_registered' ], 10, 2 );
	}

	public function on_account_registered( int $user_id, bool $is_new ): void {
		if ( ! $is_new ) {
			return; // Only a genuinely new account can ever be a referee -- an existing user logging back in never re-attributes.
		}

		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- sanitized on the next line, not used raw.
		$code = isset( $_COOKIE['bc_ref'] ) ? sanitize_text_field( wp_unslash( (string) $_COOKIE['bc_ref'] ) ) : '';

		if ( '' !== $code ) {
			( new ReferralService() )->attribute( $code, $user_id );
		}

		// Consumed regardless of whether attribution actually succeeded
		// (unknown code, self-referral guard, or already-referred) -- a
		// browser shared across multiple real signups (e.g. a shared/
		// library computer) must not keep re-attempting the same stale
		// code against every later signup.
		if ( '' !== $code && ! headers_sent() ) {
			setcookie( 'bc_ref', '', time() - HOUR_IN_SECONDS, '/', '', is_ssl(), true );
		}
	}
}
