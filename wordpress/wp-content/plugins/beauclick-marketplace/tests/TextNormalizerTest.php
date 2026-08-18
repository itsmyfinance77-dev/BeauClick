<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\Search\TextNormalizer;
use WP_UnitTestCase;

/** V2.4 Step 21 (Search & Discovery Evolution). */
final class TextNormalizerTest extends WP_UnitTestCase {

	public function test_persian_digits_normalize_to_ascii(): void {
		$this->assertSame( '20 sal', TextNormalizer::normalize( '۲۰ sal' ) );
	}

	public function test_arabic_indic_digits_normalize_to_ascii(): void {
		$this->assertSame( '20 sal', TextNormalizer::normalize( '٢٠ sal' ) );
	}

	public function test_real_arabic_kaf_normalizes_to_persian_keheh(): void {
		$this->assertSame( TextNormalizer::normalize( 'ک' ), TextNormalizer::normalize( 'ك' ) );
	}

	public function test_real_arabic_yeh_normalizes_to_persian_farsi_yeh(): void {
		$this->assertSame( TextNormalizer::normalize( 'ی' ), TextNormalizer::normalize( 'ي' ) );
	}

	public function test_zwnj_joined_word_matches_its_non_zwnj_spelling(): void {
		$this->assertSame( TextNormalizer::normalize( 'میکاپ' ), TextNormalizer::normalize( "می\u{200C}کاپ" ) );
	}

	public function test_a_real_space_between_distinct_words_remains_a_boundary(): void {
		// Unlike ZWNJ, an ordinary space must not be stripped -- "می کاپ"
		// (two separate tokens) staying distinct from "میکاپ" (one word) is
		// what stops unrelated multi-word phrases from becoming
		// indistinguishable under normalization.
		$this->assertNotSame( TextNormalizer::normalize( 'میکاپ' ), TextNormalizer::normalize( 'می کاپ' ) );
	}

	public function test_multiple_internal_spaces_collapse_to_one(): void {
		$this->assertSame( 'کاشت ناخن', TextNormalizer::normalize( 'کاشت    ناخن' ) );
	}

	public function test_alef_variants_normalize_together(): void {
		$this->assertSame( TextNormalizer::normalize( 'اباد' ), TextNormalizer::normalize( 'آباد' ) );
	}

	public function test_already_normalized_persian_text_is_unchanged_besides_case(): void {
		$this->assertSame( 'سالن زیبایی مریم', TextNormalizer::normalize( 'سالن زیبایی مریم' ) );
	}
}
