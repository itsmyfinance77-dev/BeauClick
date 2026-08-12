<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Sms;

/**
 * Mirrors beauclick-ai\ProviderFactory exactly: env-gated selection, no
 * provider special-cased in application code. BC_SMS_PROVIDER/
 * BC_SMS_API_KEY are not set in any environment this project has run in
 * (Gap Register AUTH-04) -- MockSmsProvider is the only provider ever
 * actually exercised today, and that's a real, honest fact this factory
 * makes visible rather than hides behind a fake "it works" real-provider
 * class with no real credentials behind it.
 */
final class SmsProviderFactory {

	public static function create(): SmsProvider {
		$provider = getenv( 'BC_SMS_PROVIDER' ) ?: ( defined( 'BC_SMS_PROVIDER' ) ? BC_SMS_PROVIDER : '' );
		$api_key  = getenv( 'BC_SMS_API_KEY' ) ?: ( defined( 'BC_SMS_API_KEY' ) ? BC_SMS_API_KEY : '' );

		if ( $provider && $api_key ) {
			// A real gateway adapter (Kavenegar/IPPanel/Melipayamak/etc.)
			// would be selected and constructed here once credentials
			// genuinely exist -- deliberately not built speculatively
			// against a provider this project has no contract with yet
			// (matches this codebase's own standing "do not invent
			// credentials" instruction). Falls through to the mock today.
		}

		return new MockSmsProvider();
	}
}
