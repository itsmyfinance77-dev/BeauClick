<?php
/**
 * BeauClick's own sign-in/sign-up experience (V2.1 Step 6) -- phone/OTP,
 * matching the app's own design system. Replaces wp-login.php as the path
 * every normal customer/professional/business account uses; WordPress's
 * own login screen remains the administrator path and is never linked from
 * here or from any other normal-user-facing surface.
 *
 * An already-logged-in visitor has nothing to do on this page -- redirect
 * straight to their dashboard rather than showing them a sign-in form for
 * an account they're already in.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( is_user_logged_in() ) {
	wp_safe_redirect( home_url( '/dashboard/' ) );
	exit;
}

get_header();

bc_enqueue_app_bundle( 'auth' );
?>

<div class="bc-container bc-section">
	<div id="bc-auth-root"></div>
</div>

<?php
get_footer();
