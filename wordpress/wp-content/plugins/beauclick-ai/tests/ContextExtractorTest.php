<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\ContextExtractor;
use WP_UnitTestCase;

final class ContextExtractorTest extends WP_UnitTestCase {

	private function make_city( string $name_fa, bool $launched = true ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_cities',
			[ 'province_id' => 1, 'name_fa' => $name_fa, 'slug' => sanitize_title( $name_fa ) . '-' . wp_rand(), 'is_launched' => $launched ? 1 : 0 ],
			[ '%d', '%s', '%s', '%d' ]
		);
		return $wpdb->insert_id;
	}

	public function test_extracts_a_specialty_mentioned_by_name(): void {
		if ( ! taxonomy_exists( 'bc_specialty' ) ) {
			$this->markTestSkipped( 'beauclick-marketplace not active.' );
		}
		$term = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$extractor = new ContextExtractor();

		$found = $extractor->extract_specialty_ids( 'دنبال یک میکاپ‌آرتیست خوب برای عروسی هستم' );

		$this->assertContains( (int) $term['term_id'], $found );
	}

	public function test_extracts_no_specialty_from_unrelated_text(): void {
		$extractor = new ContextExtractor();
		$this->assertSame( [], $extractor->extract_specialty_ids( 'سلام چطوری؟' ) );
	}

	public function test_extracts_a_launched_city_mentioned_by_name(): void {
		$city_id = $this->make_city( 'یزد' );
		$extractor = new ContextExtractor();

		$this->assertSame( $city_id, $extractor->extract_city_id( 'من تو یزد زندگی می‌کنم' ) );
	}

	public function test_ignores_an_unlaunched_city(): void {
		$this->make_city( 'شهر-ناموجود-تست', false );
		$extractor = new ContextExtractor();

		$this->assertNull( $extractor->extract_city_id( 'من تو شهر-ناموجود-تست زندگی می‌کنم' ) );
	}

	public function test_extracts_a_budget_with_million_multiplier(): void {
		$extractor = new ContextExtractor();
		$this->assertSame( 2_000_000, $extractor->extract_budget( 'بودجه من حدود ۲ میلیون تومانه' ) );
	}

	public function test_extracts_a_budget_with_thousand_multiplier(): void {
		$extractor = new ContextExtractor();
		$this->assertSame( 500_000, $extractor->extract_budget( '۵۰۰ هزار تومان بودجه دارم' ) );
	}

	public function test_an_unrelated_number_is_not_mistaken_for_a_budget(): void {
		$extractor = new ContextExtractor();
		$this->assertNull( $extractor->extract_budget( 'برای ۵ نفر رزرو می‌خوام' ) );
	}

	public function test_extracts_a_product_category_mentioned_by_name(): void {
		$term = wp_insert_term( 'مراقبت پوست', 'product_cat' );
		$extractor = new ContextExtractor();

		$found = $extractor->extract_product_category_ids( 'یه کرم برای مراقبت پوست می‌خوام' );

		$this->assertContains( (int) $term['term_id'], $found );
	}

	/**
	 * V2.0 Step 2 fix: the roadmap's own primary example ("برای پوست چرب و
	 * جوش‌دار یه روتین ساده می‌خوام") never contains a multi-word term's full
	 * name verbatim -- a word-level fallback match is required or this
	 * example (and any natural phrasing like it) would extract nothing.
	 */
	public function test_a_multiword_term_matches_via_a_significant_word_not_just_the_full_phrase(): void {
		$term = wp_insert_term( 'پوست و مو', 'bc_specialty' );
		$extractor = new ContextExtractor();

		$found = $extractor->extract_specialty_ids( 'برای پوست چرب و جوش‌دار یه روتین ساده می‌خوام' );

		$this->assertContains( (int) $term['term_id'], $found, 'A significant word from a multi-word term name must match natural phrasing that never contains the full phrase.' );
	}

	public function test_short_connective_words_do_not_false_match_a_multiword_term(): void {
		wp_insert_term( 'رنگ و مش', 'bc_specialty' );
		$extractor = new ContextExtractor();

		// Contains "و" (a 1-character connective word inside the term name)
		// but none of the term's real significant words -- must not match.
		$found = $extractor->extract_specialty_ids( 'من و دوستم می‌خوایم بریم بیرون' );

		$this->assertSame( [], $found );
	}
}
