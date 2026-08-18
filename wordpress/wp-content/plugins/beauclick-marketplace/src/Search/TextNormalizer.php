<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

/**
 * V2.3 Step 20 (MKT-02): the same normalize-Persian/Arabic-digits-to-ASCII
 * idea CrmService::normalize_digits() already established for CRM search
 * (beauclick-booking), duplicated here rather than reached across the
 * plugin boundary for a five-line pure function — the same "keep the
 * existing surface at zero regression risk" call this codebase already
 * made for ProfessionalRuleBasedProvider (Step 19). Used on both sides of
 * a LIKE comparison: Indexer::sync() normalizes name+bio into search_text
 * at index time, MarketplaceController::browse() normalizes the incoming
 * `q` the same way, so a search matches regardless of which numeral
 * system either side happens to use.
 *
 * V2.4 Step 21 (Search & Discovery Evolution): extended with Persian/Arabic
 * *letter* normalization, the other half of "same word, different input" a
 * Persian keyboard/OS commonly produces — Arabic ك/ي (U+0643/U+064A) instead
 * of Persian ک/ی (U+06A9/U+06CC) is the single most common source of a
 * real word failing to match itself in `LIKE` search, independent of digits.
 * ZWNJ (نیم‌فاصله, U+200C) is folded to a plain space for matching purposes
 * only — "می‌کاپ" (with ZWNJ) and "میکاپ" (without) must match the same
 * content; display-side ZWNJ (receipts, labels) is untouched, this class
 * only ever feeds a LIKE comparison, never renders anything.
 */
final class TextNormalizer {

	private const DIGIT_MAP = [
		'۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
		'٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
	];

	/**
	 * Arabic presentation forms → their canonical Persian letter. Not an
	 * exhaustive Arabic-orthography table — only the handful of letters
	 * that actually turn up in real Persian typing from non-Persian
	 * keyboards/OS locales (confirmed against this project's own real
	 * provider bio/name content, not a theoretical full Unicode mapping).
	 */
	private const LETTER_MAP = [
		'ك' => 'ک', // Arabic Kaf -> Persian Keheh
		'ي' => 'ی', // Arabic Yeh -> Persian Farsi Yeh
		'ة' => 'ه', // Teh Marbuta -> Heh
		'ؤ' => 'و',
		'إ' => 'ا',
		'أ' => 'ا',
		'آ' => 'ا', // matching-only: a query for "اباد" must still find "آباد"
	];

	public static function normalize( string $s ): string {
		$s = strtr( $s, self::DIGIT_MAP );
		$s = strtr( $s, self::LETTER_MAP );
		// ZWNJ (نیم‌فاصله) joins the two halves of one compound word — its
		// presence is genuinely inconsistent in real Persian text ("میکاپ"
		// and "می‌کاپ" are the same word), so it's removed entirely rather
		// than treated as a separator, unlike an ordinary space between two
		// actually-distinct words (which must stay a word boundary — merging
		// those would make unrelated multi-word phrases indistinguishable).
		$s = str_replace( "\xE2\x80\x8C", '', $s ); // U+200C ZWNJ
		$s = preg_replace( '/\s+/u', ' ', $s ) ?? $s;
		return mb_strtolower( trim( $s ) );
	}
}
