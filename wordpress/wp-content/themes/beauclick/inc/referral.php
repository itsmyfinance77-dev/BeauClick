<?php
/**
 * V2.2 Step 12 — referral link attribution capture.
 *
 * Any page loaded with `?ref=CODE` sets a first-party `bc_ref` cookie
 * (first-touch: never overwrites an existing one, so the FIRST referral
 * link a visitor clicks wins — the standard, simplest attribution rule,
 * matching this task's own "avoid a sophisticated fraud platform"
 * instruction by not needing a more elaborate multi-touch model). This is
 * deliberately a plain PHP cookie, not a JS/sessionStorage mechanism: there
 * is no single app-shell bundle mounted on every page (each page enqueues
 * only the specific bundle(s) it needs — see inc/app-shell.php's own
 * docblock), so a visitor could land on a professional's profile via a
 * referral link (no JS bundle relevant to referral capture there) and only
 * later navigate to /auth/ themselves; a cookie survives that navigation
 * with zero JS and zero extra network requests anywhere.
 *
 * `beauclick-auth`'s AuthController reads this cookie directly (via
 * `$_COOKIE['bc_ref']`) at the moment a brand-new account is created and
 * fires `beauclick/auth/account_registered` — `beauclick-referral`'s own
 * listener does the actual code lookup/validation/attribution. This file
 * only ever captures and stores the raw code; it never trusts or validates
 * it as a real referral code itself (that's `beauclick-referral`'s job,
 * server-side, at the one moment it actually matters).
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'init', 'bc_capture_referral_cookie' );

function bc_capture_referral_cookie(): void {
	if ( headers_sent() ) {
		return;
	}

	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only capture of a public referral code, not a state-changing action.
	$ref = isset( $_GET['ref'] ) ? sanitize_text_field( wp_unslash( (string) $_GET['ref'] ) ) : '';
	if ( '' === $ref || ! preg_match( '/^[A-Z0-9]{4,16}$/', $ref ) ) {
		return; // Not shaped like a real code -- real validation happens server-side in beauclick-referral anyway, this is just cheap noise-filtering.
	}

	if ( ! empty( $_COOKIE['bc_ref'] ) ) {
		return; // First-touch attribution: never overwrite an existing pending referral cookie.
	}

	// 30 days: a reasonable, generic technical default for "how long a
	// referral link stays attributable," not a reward-amount business
	// decision (see beauclick-referral\ReferralConfig for the actual
	// business-decision-pending values). Filterable if this ever needs to
	// change without a deploy.
	$ttl_days = (int) apply_filters( 'beauclick/referral/attribution_window_days', 30 );
	setcookie( 'bc_ref', $ref, time() + ( $ttl_days * DAY_IN_SECONDS ), '/', '', is_ssl(), true );
}
