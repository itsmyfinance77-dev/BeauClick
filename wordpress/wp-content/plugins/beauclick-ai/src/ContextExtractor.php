<?php
declare( strict_types=1 );

namespace BeauClick\AI;

/**
 * Light, deterministic Persian-text signal extraction — not an NLU service.
 * Reads real catalog data (specialty terms, launched cities) rather than a
 * hardcoded keyword list, so a new specialty/city becomes matchable the
 * moment it exists, with no code change here.
 */
final class ContextExtractor {

	/** @return int[] bc_specialty term IDs whose name appears in the message. */
	public function extract_specialty_ids( string $text ): array {
		$terms = get_terms( [ 'taxonomy' => 'bc_specialty', 'hide_empty' => false ] );
		if ( is_wp_error( $terms ) ) {
			return [];
		}

		$found = [];
		foreach ( $terms as $term ) {
			if ( '' !== $term->name && str_contains( $text, $term->name ) ) {
				$found[] = (int) $term->term_id;
			}
		}
		return $found;
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
