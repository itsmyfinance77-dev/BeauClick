<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Sms;

/**
 * Mirrors beauclick-ai's ProviderInterface -- one small seam, every real
 * provider decision (which gateway, credentials, retry policy) lives behind
 * it, application code never special-cases a specific vendor's API.
 */
interface SmsProvider {

	public function send( string $toE164, string $message ): SmsResult;
}
