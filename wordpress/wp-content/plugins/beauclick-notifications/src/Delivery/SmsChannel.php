<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Delivery;

use BeauClick\Auth\Phone\PhoneNormalizer;
use BeauClick\Auth\Sms\SmsProviderFactory;

/**
 * Reuses beauclick-auth's existing SmsProvider abstraction verbatim --
 * SmsProviderFactory::create() is the SAME factory OtpService already
 * calls, so this plugin never special-cases a gateway and automatically
 * gets a real provider the moment BC_SMS_PROVIDER/BC_SMS_API_KEY are ever
 * configured, with zero code change here (§10's explicit "do not create
 * another SMS interface" instruction).
 */
final class SmsChannel {

	/** @return array{recipient:?string, success:bool, error:?string} */
	public function send( int $user_id, string $body ): array {
		$raw = get_user_meta( $user_id, '_billing_phone', true );
		$e164 = $raw ? PhoneNormalizer::normalize( (string) $raw ) : null;

		if ( ! $e164 ) {
			return [ 'recipient' => null, 'success' => false, 'error' => 'no_phone' ];
		}

		$result = SmsProviderFactory::create()->send( $e164, $body );

		return [
			'recipient' => PhoneNormalizer::masked( $e164 ),
			'success'   => $result->success,
			'error'     => $result->error,
		];
	}
}
