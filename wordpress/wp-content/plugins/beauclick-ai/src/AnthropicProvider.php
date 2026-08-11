<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Real adapter for Anthropic's Messages API, used only when BC_AI_PROVIDER=
 * anthropic and BC_AI_API_KEY are both set (see ProviderFactory) — every
 * local/dev install runs on RuleBasedProvider instead. The API key is read
 * server-side only (bc_env()), never sent to the frontend.
 *
 * Not exercised against a live API in this environment: architecture doc
 * §16 flags that major AI providers generally restrict direct API access
 * from Iranian IPs, so verifying this adapter against the real endpoint is
 * an infra/outbound-access decision, not something this codebase can
 * resolve on its own. The interface contract and JSON parsing are still
 * real and tested (ProviderFactoryTest, AnthropicProvider's own parsing
 * logic) — only the live HTTP round trip is unverified.
 */
final class AnthropicProvider implements ProviderInterface {

	private const API_URL = 'https://api.anthropic.com/v1/messages';

	public function __construct(
		private readonly string $apiKey,
		private readonly string $model,
		private readonly CatalogContext $catalog = new CatalogContext()
	) {
	}

	public function chat( array $history, array $context ): AssistantResponse {
		$system = $this->system_prompt( $context );

		$messages = array_map(
			static fn ( array $m ) => [ 'role' => $m['role'], 'content' => $m['content'] ],
			$history
		);

		$response = wp_remote_post(
			self::API_URL,
			[
				'timeout' => 20,
				'headers' => [
					'x-api-key'         => $this->apiKey,
					'anthropic-version' => '2023-06-01',
					'content-type'      => 'application/json',
				],
				'body'    => wp_json_encode(
					[
						'model'      => $this->model,
						'max_tokens' => 700,
						'system'     => $system,
						'messages'   => $messages,
					]
				),
			]
		);

		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return new AssistantResponse( 'در حال حاضر امکان پاسخگویی نیست — لطفاً کمی بعد دوباره امتحان کن.' );
		}

		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$text = $body['content'][0]['text'] ?? '';

		return $this->parse( (string) $text );
	}

	private function system_prompt( array $context ): string {
		return "شما دستیار زیبایی BeauClick هستید — توصیه‌های واقعی و مرتبط بر اساس کاتالوگ واقعی ارائه می‌دهید، هرگز نام یا شناسه‌ای که در فهرست زیر نیست پیشنهاد ندهید.\n\n"
			. 'کاتالوگ در دسترس (JSON): ' . wp_json_encode( $this->catalog->summary( $context ) ) . "\n\n"
			. 'زمینه شناخته‌شده کاربر (JSON): ' . wp_json_encode( $context ) . "\n\n"
			. 'پاسخ را دقیقاً به‌صورت یک شیء JSON با کلیدهای reply (متن فارسی)، recommendations (آرایه‌ای از {type, id} فقط از کاتالوگ بالا) و context_updates (تغییرات زمینه، مثل specialtyIds/cityId/budget) بازگردانید. کلید دیگری اضافه نکنید و متن خارج از JSON ننویسید.';
	}

	/** Parses the model's JSON reply leniently — a malformed/non-JSON response degrades to plain text with no recommendations, never a fatal error. */
	private function parse( string $text ): AssistantResponse {
		$decoded = json_decode( $text, true );

		if ( ! is_array( $decoded ) || ! isset( $decoded['reply'] ) ) {
			return new AssistantResponse( '' !== $text ? $text : 'متوجه نشدم — می‌تونی دوباره توضیح بدی؟' );
		}

		$recommendations = [];
		foreach ( (array) ( $decoded['recommendations'] ?? [] ) as $r ) {
			if ( isset( $r['type'], $r['id'] ) && is_string( $r['type'] ) ) {
				$recommendations[] = [ 'type' => $r['type'], 'id' => (int) $r['id'] ];
			}
		}

		return new AssistantResponse(
			(string) $decoded['reply'],
			$recommendations,
			is_array( $decoded['context_updates'] ?? null ) ? $decoded['context_updates'] : []
		);
	}
}
