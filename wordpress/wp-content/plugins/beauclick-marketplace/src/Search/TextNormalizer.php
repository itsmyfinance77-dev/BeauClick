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
 */
final class TextNormalizer {

	public static function normalize( string $s ): string {
		$persian = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];
		$arabic  = [ '٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩' ];
		$ascii   = [ '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' ];
		$s       = str_replace( $arabic, $ascii, str_replace( $persian, $ascii, $s ) );
		return mb_strtolower( trim( $s ) );
	}
}
