<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Sms;

/**
 * The default provider whenever no real SMS gateway is configured (every
 * environment this codebase has ever run in, per the Gap Register's
 * AUTH-04 finding -- no SMS credentials exist yet). Never actually sends
 * anything.
 *
 * The message text is only ever surfaced through a real side channel
 * outside production, mirroring the exact `wp_get_environment_type() !==
 * 'production'` gate beauclick-payments\Plugin already uses to keep the
 * dev-only Cash-on-Delivery gateway from ever reaching a real deployment.
 * A production environment with no real provider configured intentionally
 * still "succeeds" here (never blocks OTP issuance with a hard error) but
 * never logs or exposes the code anywhere -- the request simply can't
 * actually be delivered, which is a deployment-configuration problem to
 * surface through OPS-04 (error monitoring), not something this class
 * should paper over by leaking the code into a production log.
 */
final class MockSmsProvider implements SmsProvider {

	public function send( string $toE164, string $message ): SmsResult {
		if ( 'production' !== wp_get_environment_type() ) {
			// error_log(), not the database and not an HTTP response -- only
			// ever reaches this environment's own PHP/server log, exactly
			// the same visibility boundary as every other dev-only debug
			// trace in this codebase, and only when it is genuinely not
			// production.
			error_log( sprintf( '[BeauClick Auth mock SMS] to=%s message=%s', $toE164, $message ) ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}

		return SmsResult::ok( 'mock-' . wp_generate_password( 12, false ) );
	}
}
