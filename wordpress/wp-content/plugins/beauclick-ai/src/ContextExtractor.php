<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Light, deterministic Persian-text signal extraction — not an NLU service.
 * Reads real catalog data (specialty terms, product categories, launched
 * cities) rather than a hardcoded keyword list, so a new specialty/category/
 * city becomes matchable the moment it exists, with no code change here.
 */
final class ContextExtractor {

	/** @return int[] bc_specialty term IDs whose name (or a significant word within it) appears in the message. */
	public function extract_specialty_ids( string $text ): array {
		return $this->match_terms( $text, 'bc_specialty' );
	}

	/**
	 * V2.0 Step 2: product recommendations need a way to connect free text
	 * ("پوست چرب و جوش‌دار") to WooCommerce's own product_cat taxonomy
	 * ("مراقبت پوست") — same real-taxonomy-driven approach as specialty
	 * extraction, not a separate hardcoded product keyword list.
	 *
	 * @return int[] product_cat term IDs whose name (or a significant word within it) appears in the message.
	 */
	public function extract_product_category_ids( string $text ): array {
		return $this->match_terms( $text, 'product_cat' );
	}

	/** @return int[] */
	private function match_terms( string $text, string $taxonomy ): array {
		$terms = get_terms( [ 'taxonomy' => $taxonomy, 'hide_empty' => false ] );
		if ( is_wp_error( $terms ) ) {
			return [];
		}

		$found = [];
		foreach ( $terms as $term ) {
			if ( '' !== $term->name && $this->term_matches( $term->name, $text ) ) {
				$found[] = (int) $term->term_id;
			}
		}
		return $found;
	}

	/**
	 * A user rarely types a multi-word term name verbatim ("پوست و مو" is a
	 * specialty, but "برای پوست چرب یه روتین می‌خوام" never contains that
	 * exact phrase — it contains "پوست"). Exact-substring match still wins
	 * as the fast path for single-word terms ("میکاپ"); for multi-word
	 * terms, a real match against any one significant word (3+ characters,
	 * so short connective words like "و" can't false-match) counts too.
	 */
	private function term_matches( string $term_name, string $text ): bool {
		if ( str_contains( $text, $term_name ) ) {
			return true;
		}

		foreach ( preg_split( '/\s+/u', $term_name ) ?: [] as $word ) {
			if ( mb_strlen( $word ) >= 3 && str_contains( $text, $word ) ) {
				return true;
			}
		}

		return false;
	}

	public function extract_city_id( string $text ): ?int {
		global $wpdb;
		$cities = $wpdb->get_results( "SELECT id, name_fa FROM {$wpdb->prefix}bc_cities WHERE is_launched = 1", ARRAY_A );

		foreach ( (array) $cities as $city ) {
			if ( '' !== $city['name_fa'] && str_contains( $text, $city['name_fa'] ) ) {
				return (int) $city['id'];
			}
		}
		return null;
	}

	/**
	 * Reads a Toman budget out of free text — handles Persian digits and the
	 * "میلیون"/"هزار" multipliers users actually write in ("یک میلیون",
	 * "۵۰۰ هزار تومان") rather than requiring a bare number.
	 */
	public function extract_budget( string $text ): ?int {
		$normalized = strtr( $text, [ '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9' ] );

		// Only a digit sequence next to "تومان"/"بودجه" or a magnitude word
		// counts as a budget — an unrelated number ("برای ۵ نفر") must not
		// be misread as one.
		if ( ! preg_match( '/(\d[\d,]*)\s*(میلیون|هزار)?\s*(تومان|بودجه)?/u', $normalized, $m ) ) {
			return null;
		}

		// PCRE omits trailing optional groups entirely (not just as '') when
		// they don't participate in the match, so index access here goes
		// through `?? ''` rather than assuming the key exists.
		$multiplier = $m[2] ?? '';
		$keyword    = $m[3] ?? '';
		if ( '' === $multiplier && '' === $keyword ) {
			return null;
		}

		$amount = (int) str_replace( ',', '', $m[1] );
		if ( 0 === $amount ) {
			return null;
		}

		return match ( $multiplier ) {
			'میلیون' => $amount * 1_000_000,
			'هزار'   => $amount * 1_000,
			default  => $amount,
		};
	}
}
