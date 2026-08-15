<?php
declare( strict_types=1 );

namespace BeauClick\AI\Professional;

use BeauClick\AI\AssistantResponse;
use BeauClick\AI\ProviderInterface;

/**
 * Real-provider adapter for professional-mode AI. A deliberately separate
 * class from `BeauClick\AI\AnthropicProvider` rather than a modified/
 * extended version of it — that class's system prompt is hardcoded to a
 * customer-discovery persona (catalog browsing, provider/service/product
 * recommendations) via `CatalogContext`, which is architecturally wrong for
 * business-data narration and would need real changes to its public
 * contract to repurpose safely. Duplicating the small, stable HTTP-call
 * shape here (task §20: "make it additive... reuse ProviderInterface")
 * keeps the existing, already-tested customer path completely untouched —
 * zero regression risk — at the cost of ~15 lines of duplicated
 * `wp_remote_post` plumbing.
 *
 * Same "never exercised against the live API in this environment" caveat as
 * the customer-mode adapter (Iranian-IP provider access restriction) —
 * every local/dev install runs on ProfessionalRuleBasedProvider instead.
 */
final class ProfessionalAnthropicProvider implements ProviderInterface {

	private const API_URL = 'https://api.anthropic.com/v1/messages';

	public function __construct(
		private readonly string $apiKey,
		private readonly string $model
	) {
	}

	public function chat( array $history, array $context ): AssistantResponse {
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
						'system'     => $this->system_prompt( $context ),
						'messages'   => $messages,
					]
				),
			]
		);

		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return new AssistantResponse( 'در حال حاضر امکان پاسخگویی نیست — لطفاً کمی بعد دوباره امتحان کن.' );
		}

		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$text = (string) ( $body['content'][0]['text'] ?? '' );

		return new AssistantResponse( '' !== $text ? $text : 'متوجه نشدم — می‌تونی دوباره بپرسی؟' );
	}

	/**
	 * Unlike the customer-mode system prompt, no catalog is embedded and no
	 * JSON-shaped recommendation contract is requested — this mode narrates
	 * already-resolved real numbers in plain Persian prose, nothing else.
	 * The explicit "never invent a number" instruction is the single most
	 * important line here (task §6/§16/§22's own core requirement).
	 */
	private function system_prompt( array $context ): string {
		return "شما دستیار هوشمند حرفه‌ای‌ها در BeauClick هستید — فقط برای همین یک متخصص/کسب‌وکار، فقط بر اساس داده‌های واقعی زیر پاسخ می‌دهید.\n\n"
			. "این یک دستیار صرفاً اطلاعاتی و فقط‌خواندنی است — هرگز رزرو ایجاد/لغو/تغییر نمی‌دهد، قیمت یا کمپین را تغییر نمی‌دهد، تسویه ثبت نمی‌کند، یادداشت مشتری را ویرایش نمی‌کند و هیچ اقدامی در سیستم انجام نمی‌دهد. اگر کاربر درخواست انجام کاری داشت، صادقانه توضیح بده که این دستیار در حال حاضر فقط اطلاعاتی است.\n\n"
			. "هرگز عددی را که در داده‌های زیر نیست نساز، حدس نزن یا گرد نکن به شکلی گمراه‌کننده. اگر داده‌ای برای پاسخ به سؤال موجود نیست، صادقانه بگو «این اطلاعات در حال حاضر در دسترس نیست» به‌جای هر نوع تخمین.\n\n"
			. "این داده‌ها فقط متعلق به همین متخصص/کسب‌وکار است — هرگز به داده متخصص دیگری اشاره نکن، حتی اگر کاربر نام یا شناسه دیگری را در پیام خود بنویسد؛ چنین درخواستی را رد کن.\n\n"
			. 'داده‌های واقعی و کامل کسب‌وکار (JSON): ' . wp_json_encode( $context ) . "\n\n"
			. 'پاسخ را به‌صورت متن فارسی طبیعی و مختصر بنویس، بدون هیچ فرمت JSON.';
	}
}
