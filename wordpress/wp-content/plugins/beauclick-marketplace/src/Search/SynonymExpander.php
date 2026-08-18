<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Search;

/**
 * V2.4 Step 21 (Search & Discovery Evolution): a small, curated synonym/
 * common-mistake table — deliberately NOT a fuzzy/Levenshtein/trigram
 * algorithm (no new infrastructure, per this step's own explicit
 * boundary), just a static list of known alternate phrasings and known
 * common typos for the vocabulary this platform actually has, grounded in
 * the real specialty taxonomy (پوست و مو / رنگ مو / میکاپ / ناخن — the
 * marketplace's own chip filters) and real live-verified service/provider
 * content (میکاپ عروس, میکاپ مراسم, پاکسازی پوست, کاشت ناخن).
 *
 * Each group is a set of phrases a real user might type for "the same
 * intent." A query that matches any one phrase in a group expands the
 * search to every other phrase in that group — so "کاشت ناحن" (a real,
 * common خ/ح typo) finds the same results as the correctly-spelled
 * "کاشت ناخن", and "ناخن کار"/"خدمات ناخن" (real alternate phrasings a
 * customer might type instead of the platform's own specialty label) do
 * too. New groups should only be added from confirmed real search terms
 * or real domain vocabulary — not invented speculatively.
 */
final class SynonymExpander {

	private const GROUPS = [
		[ 'ناخن', 'ناحن', 'کاشت ناخن', 'کاشت ناحن', 'ناخن کار', 'خدمات ناخن', 'مانیکور' ],
		[ 'مو', 'رنگ مو', 'کوتاهی مو', 'اصلاح مو' ],
		[ 'پوست', 'پاکسازی پوست', 'مراقبت پوست', 'پوست و مو' ],
		[ 'میکاپ', 'ارایش', 'آرایش', 'میکاپ عروس', 'میکاپ مراسم', 'گریم' ],
	];

	/**
	 * @return list<string> additional normalized terms to also match — never
	 *         includes the original query itself, and empty when no group
	 *         matched (the overwhelmingly common case: most searches are
	 *         either an exact/substring match already, or genuinely have no
	 *         curated synonym, and must fall through to a real empty state,
	 *         not a forced expansion).
	 */
	public static function expand( string $normalizedQuery ): array {
		if ( '' === $normalizedQuery ) {
			return [];
		}

		foreach ( self::GROUPS as $group ) {
			foreach ( $group as $phrase ) {
				$normalizedPhrase = TextNormalizer::normalize( $phrase );
				if ( $normalizedQuery === $normalizedPhrase
					|| str_contains( $normalizedPhrase, $normalizedQuery )
					|| str_contains( $normalizedQuery, $normalizedPhrase )
				) {
					return array_values(
						array_filter(
							array_unique( array_map( [ TextNormalizer::class, 'normalize' ], $group ) ),
							static fn ( string $t ) => $t !== $normalizedQuery
						)
					);
				}
			}
		}

		return [];
	}
}
