<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * "Basic prompt-injection/profanity guard before forwarding user text to
 * the provider" — architecture doc §20, explicitly scoped as a light gate,
 * not a full moderation service. Rejects obviously malicious system-prompt
 * overrides and oversized input; real content moderation for AI output is
 * covered separately by CatalogContext + AssistantService's ID validation.
 */
final class MessageGuard {

	private const MAX_LENGTH = 1000;

	/** @var string[] */
	private const INJECTION_PHRASES = [
		'ignore previous instructions',
		'ignore all previous instructions',
		'disregard previous instructions',
		'you are now',
		'system prompt',
		'دستورات قبلی را نادیده',
	];

	public function check( string $text ): ?string {
		$text = trim( $text );

		if ( '' === $text ) {
			return 'متن پیام نمی‌تواند خالی باشد.';
		}
		if ( mb_strlen( $text ) > self::MAX_LENGTH ) {
			return 'پیام شما بیش از حد طولانی است.';
		}

		$lower = mb_strtolower( $text );
		foreach ( self::INJECTION_PHRASES as $phrase ) {
			if ( str_contains( $lower, $phrase ) ) {
				return 'این پیام قابل پردازش نیست.';
			}
		}

		return null;
	}
}
