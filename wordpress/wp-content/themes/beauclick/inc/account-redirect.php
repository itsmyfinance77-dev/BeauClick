<?php
/**
 * WooCommerce's native "My Account" endpoints fall back to their own
 * embedded username/password login form (myaccount/form-login.php) for a
 * logged-out visitor -- the exact password-based UX beauclick-auth's phone/
 * OTP flow was built to replace for every normal customer/professional/
 * business account (see beauclick-auth\Rest\AuthController's own docblock;
 * AUTH-09 in the Product Gap Register documents passwords as no longer part
 * of the normal user UX at all). A logged-out visit to /my-account/* -- a
 * bookmark, a shared link, a session that expired mid-visit -- landed on a
 * form no normal account can actually use, found during the Global UI/UX
 * audit. page-dashboard.php already sends a logged-out /dashboard/ visitor
 * to /auth/; this mirrors that same redirect for WooCommerce's own account
 * pages rather than leaving a second, inconsistent dead end.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'template_redirect',
	static function (): void {
		if ( is_user_logged_in() || ! function_exists( 'is_account_page' ) || ! is_account_page() ) {
			return;
		}

		wp_safe_redirect( home_url( '/auth/' ) );
		exit;
	}
);
