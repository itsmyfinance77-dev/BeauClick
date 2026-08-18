<?php
declare( strict_types=1 );

namespace BeauClick\AI\Professional;

use BeauClick\AI\AssistantResponse;
use BeauClick\AI\ProviderInterface;

/**
 * Default provider when BC_AI_API_KEY isn't configured (every local/dev
 * install today, and — per beauclick-ai\AnthropicProvider's own documented
 * Iranian-IP access concern — a real operational fallback in production
 * too). Unlike RuleBasedProvider (customer-mode, which extracts discovery
 * INTENT from free text via ContextExtractor and queries the catalog),
 * this class never interprets the professional's free text as anything
 * more than a keyword lookup into an ALREADY-fully-resolved, ALREADY-
 * ownership-scoped $context (see ProfessionalContext) — every number it
 * ever says back is one already present in $context, never invented,
 * never re-derived, never a guess. Task §22's own explicit requirement:
 * "The fallback must never fabricate professional metrics."
 *
 * This also makes prompt injection structurally moot for this provider:
 * there is no LLM here to manipulate — the professional's text only ever
 * selects which pre-computed real number(s) to narrate, never what to say
 * about them.
 */
final class ProfessionalRuleBasedProvider implements ProviderInterface {

	public function chat( array $history, array $context ): AssistantResponse {
		$latest = end( $history );
		$text   = $latest && 'user' === $latest['role'] ? mb_strtolower( (string) $latest['content'] ) : '';

		$topics = $this->matched_topics( $text );

		if ( ! $topics ) {
			return new AssistantResponse( $this->help_reply() );
		}

		$parts = [];
		foreach ( $topics as $topic ) {
			$parts[] = $this->narrate( $topic, $context );
		}

		return new AssistantResponse( self::to_persian_digits( implode( "\n\n", $parts ) ) );
	}

	/**
	 * Every other user-facing surface in this codebase (dates, prices,
	 * dashboard stats, OTP codes) renders digits in Persian — this
	 * provider's narrated numbers (booking counts, conversion rate,
	 * تومان amounts) were the one place still emitting raw Latin digits
	 * and English-style commas, found during the Global UI/UX audit.
	 * Applied once here, at the single return point, rather than at each
	 * narrate_*() call site.
	 */
	private static function to_persian_digits( string $text ): string {
		// ',' -> '٬' first: the same Arabic thousands separator every تومان
		// amount elsewhere in this codebase uses (see app/src/lib/format.ts's
		// own toPersianToman()), not a second, differently-formatted number.
		return strtr( $text, [ ',' => '٬', '0' => '۰', '1' => '۱', '2' => '۲', '3' => '۳', '4' => '۴', '5' => '۵', '6' => '۶', '7' => '۷', '8' => '۸', '9' => '۹' ] );
	}

	/** @return list<string> */
	private function matched_topics( string $text ): array {
		$keywords = [
			'bookings'   => [ 'رزرو', 'بوکینگ', 'نوبت' ],
			'services'   => [ 'خدمت', 'سرویس', 'محبوب' ],
			'reviews'    => [ 'نظر', 'امتیاز', 'ریویو', 'رضایت' ],
			'customers'  => [ 'مشتری', 'مشتریان' ],
			'financial'  => [ 'درآمد', 'مالی', 'تسویه', 'مطالبات', 'پول' ],
			'campaigns'  => [ 'کمپین', 'تخفیف', 'پروموشن' ],
			'overview'   => [ 'خلاصه', 'عملکرد', 'کلی', 'چطور', 'وضعیت' ],
		];

		$topics = [];
		foreach ( $keywords as $topic => $words ) {
			foreach ( $words as $word ) {
				if ( str_contains( $text, $word ) ) {
					$topics[] = $topic;
					break;
				}
			}
		}

		if ( in_array( 'overview', $topics, true ) ) {
			return [ 'bookings', 'services', 'reviews', 'financial' ];
		}

		return array_values( array_unique( $topics ) );
	}

	/** @param array<string, mixed> $context */
	private function narrate( string $topic, array $context ): string {
		$analytics = (array) ( $context['analytics'] ?? [] );

		return match ( $topic ) {
			'bookings'  => $this->narrate_bookings( (array) ( $analytics['funnel'] ?? [] ) ),
			'services'  => $this->narrate_services( (array) ( $analytics['servicePerformance'] ?? [] ) ),
			'reviews'   => $this->narrate_reviews( (array) ( $analytics['reviews'] ?? [] ) ),
			'customers' => $this->narrate_customers( (array) ( $analytics['customers'] ?? [] ) ),
			'financial' => $this->narrate_financial( (array) ( $context['financial'] ?? [] ) ),
			'campaigns' => $this->narrate_campaigns( (array) ( $context['campaigns'] ?? [] ) ),
			default     => 'این اطلاعات در حال حاضر در دسترس نیست.',
		};
	}

	private function narrate_bookings( array $funnel ): string {
		if ( ! $funnel ) {
			return 'اطلاعات رزرو در حال حاضر در دسترس نیست.';
		}
		return sprintf(
			'در ۳۰ روز اخیر %d رزرو شروع شده، %d مورد تکمیل شده و %d مورد لغو شده — نرخ تبدیل %s٪.',
			(int) ( $funnel['started'] ?? 0 ),
			(int) ( $funnel['completed'] ?? 0 ),
			(int) ( $funnel['cancelled'] ?? 0 ),
			number_format( (float) ( $funnel['conversionRate'] ?? 0 ) * 100, 1 )
		);
	}

	private function narrate_services( array $performance ): string {
		if ( ! $performance ) {
			return 'در این بازه زمانی، رزرو تکمیل‌شده‌ای برای هیچ خدمتی ثبت نشده است.';
		}
		$top = $performance[0];
		return sprintf(
			'پرمشتری‌ترین خدمت شما «%s» با %d رزرو تکمیل‌شده در ۳۰ روز اخیر است.',
			(string) ( $top['serviceName'] ?? '' ),
			(int) ( $top['completedCount'] ?? 0 )
		);
	}

	private function narrate_reviews( array $reviews ): string {
		$count = (int) ( $reviews['count'] ?? 0 );
		if ( 0 === $count ) {
			return 'در این بازه زمانی نظری برای شما ثبت نشده است.';
		}
		return sprintf( 'در ۳۰ روز اخیر %d نظر با میانگین امتیاز %s ثبت شده است.', $count, number_format( (float) ( $reviews['avgRating'] ?? 0 ), 1 ) );
	}

	private function narrate_customers( array $customers ): string {
		return sprintf(
			'در مجموع %d مشتری دارید که %d نفر از آن‌ها بازگشتی هستند؛ %d مشتری جدید در ۳۰ روز اخیر.',
			(int) ( $customers['total'] ?? 0 ),
			(int) ( $customers['repeat'] ?? 0 ),
			(int) ( $customers['newInRange'] ?? 0 )
		);
	}

	private function narrate_financial( array $financial ): string {
		if ( ! $financial || ! isset( $financial['summary'] ) ) {
			return 'اطلاعات مالی در حال حاضر در دسترس نیست.';
		}
		$summary = (array) $financial['summary'];
		return sprintf(
			'مجموع مطالبات خالص شما %s تومان است — %s تومان تسویه‌شده و %s تومان باقی‌مانده.',
			number_format( (int) ( $summary['receivableNet'] ?? 0 ) ),
			number_format( (int) ( $summary['settled'] ?? 0 ) ),
			number_format( (int) ( $summary['outstanding'] ?? 0 ) )
		);
	}

	private function narrate_campaigns( array $campaigns ): string {
		if ( ! $campaigns ) {
			return 'در حال حاضر کمپین فعالی برای شما ثبت نشده است.';
		}
		$names = array_map( static fn ( array $c ): string => (string) $c['name'], array_slice( $campaigns, 0, 3 ) );
		return sprintf( '%d کمپین فعال دارید: %s.', count( $campaigns ), implode( '، ', $names ) );
	}

	private function help_reply(): string {
		return 'می‌تونم درباره رزروها، خدمات محبوب، نظرات مشتریان، وضعیت مالی یا کمپین‌های فعال شما توضیح بدم — مثلاً بپرس «رزروهای من چطوره؟» یا «وضعیت مالی من چیه؟».';
	}
}
