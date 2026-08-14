<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Otp;

/**
 * Every OTP business rule in one place -- the same "single policy class"
 * pattern already established by RankingConfig (V2.0 Step 3) and
 * EarningRules (V2.0 Step 1). Nothing here is hardcoded a second time
 * anywhere else in this plugin.
 */
final class OtpConfig {

	/** Numeric code length. */
	public const CODE_LENGTH = 6;

	/** How long a code stays valid after issuance. */
	public const EXPIRY_SECONDS = 120;

	/** Wrong-code attempts allowed against one issued code before it's locked out (a new code must be requested). */
	public const MAX_VERIFY_ATTEMPTS = 5;

	/** Minimum time between two OTP requests for the same phone number. */
	public const RESEND_COOLDOWN_SECONDS = 60;

	/** Maximum OTP requests for one phone number within the window below. */
	public const MAX_REQUESTS_PER_PHONE = 5;

	/** Maximum OTP requests from one IP address within the window below -- a phone-level limit alone doesn't stop one attacker cycling through many numbers. */
	public const MAX_REQUESTS_PER_IP = 10;

	public const REQUEST_WINDOW_SECONDS = HOUR_IN_SECONDS;

	public const PURPOSE_LOGIN_OR_REGISTER      = 'login_or_register';
	public const PURPOSE_CHANGE_PHONE           = 'change_phone';

	/**
	 * V2.2 Step 14 — the one existing re-authentication mechanism this
	 * product has (no password exists for the customer/professional/
	 * business path), reused rather than duplicated for confirming
	 * account-deletion requests. Kept to 16 characters deliberately —
	 * `wp_bc_otp_requests.purpose` is `VARCHAR(20)`; a longer value here
	 * silently fails the row insert (found live, during this step's own
	 * QA pass: request_otp() doesn't check $wpdb->insert()'s return value,
	 * so the original 25-character 'confirm_account_deletion' let the SMS
	 * appear to send successfully while no row was ever written, making
	 * every subsequent verify_otp() call fail as "expired" no matter what
	 * code was entered).
	 */
	public const PURPOSE_CONFIRM_ACCOUNT_DELETION = 'confirm_deletion';
}
