<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Sms;

final class SmsResult {

	private function __construct(
		public readonly bool $success,
		public readonly ?string $providerMessageId,
		public readonly ?string $error
	) {}

	public static function ok( ?string $providerMessageId = null ): self {
		return new self( true, $providerMessageId, null );
	}

	public static function failed( string $error ): self {
		return new self( false, null, $error );
	}
}
