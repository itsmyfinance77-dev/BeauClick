<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\SearchQuery;
use BeauClick\Marketplace\Search\SqlSearchProvider;
use WP_UnitTestCase;

/**
 * V2.4 Step 21: the shared query layer both MarketplaceController::browse()
 * and the theme's bc_get_providers()/bc_search_providers() helpers now
 * delegate to. MarketplaceControllerTest already covers the REST-facing
 * behavior end to end; these tests exercise the provider directly, plus the
 * two genuinely new behaviors (synonym expansion, the zeroResult/total
 * facts on SearchResult) that sit below the REST response shape.
 */
final class SqlSearchProviderTest extends WP_UnitTestCase {

	private function make_provider( string $title, string $bio = '' ): int {
		$owner_id = self::factory()->user->create();
		return self::factory()->post->create(
			[
				'post_type'    => Registrar::PROFESSIONAL,
				'post_status'  => 'publish',
				'post_author'  => $owner_id,
				'post_title'   => $title,
				'post_content' => $bio,
			]
		);
	}

	public function test_a_typo_in_a_curated_synonym_group_still_finds_the_correct_service(): void {
		$match = $this->make_provider( 'متخصص ناخن', 'کاشت ناخن با کیفیت' );

		$result = ( new SqlSearchProvider() )->search( new SearchQuery( q: 'کاشت ناحن' ) );

		$this->assertSame( 1, $result->total );
		$this->assertSame( $match, (int) $result->rows[0]['provider_id'] );
		$this->assertTrue( $result->synonymExpanded, 'A known typo matching via its synonym group must report synonymExpanded=true.' );
	}

	public function test_an_exact_unambiguous_match_does_not_report_synonym_expansion(): void {
		$this->make_provider( 'سالن زیبایی مریم' );

		$result = ( new SqlSearchProvider() )->search( new SearchQuery( q: 'مریم' ) );

		$this->assertSame( 1, $result->total );
		$this->assertFalse( $result->synonymExpanded, 'A plain substring match with no curated synonym group involved must not claim expansion.' );
	}

	public function test_zero_results_report_is_zero_result_true(): void {
		$result = ( new SqlSearchProvider() )->search( new SearchQuery( q: 'یک عبارت کاملا نامرتبط و بی‌نتیجه' ) );

		$this->assertSame( 0, $result->total );
		$this->assertTrue( $result->isZeroResult() );
	}

	public function test_a_result_with_matches_reports_is_zero_result_false(): void {
		$this->make_provider( 'سالن زیبایی مریم' );

		$result = ( new SqlSearchProvider() )->search( new SearchQuery( q: 'مریم' ) );

		$this->assertFalse( $result->isZeroResult() );
	}

	public function test_arabic_letter_variant_in_the_query_still_matches_persian_spelled_content(): void {
		$match = $this->make_provider( 'استوديو زيبايي' ); // written with Arabic Yeh (ي) on purpose

		// Query typed with the correct Persian Yeh (ی) must still find content
		// that happens to contain the Arabic variant, and vice versa.
		$result = ( new SqlSearchProvider() )->search( new SearchQuery( q: 'استودیو زیبایی' ) );

		$this->assertContains( $match, array_map( 'intval', array_column( $result->rows, 'provider_id' ) ) );
	}

	public function test_synonym_expansion_still_ands_with_structured_filters(): void {
		global $wpdb;
		$right_city = $this->make_provider( 'سالن ناخن یک' );
		$wrong_city = $this->make_provider( 'سالن ناخن دو' );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'city_id' => 5 ], [ 'provider_id' => $right_city ] );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'city_id' => 9 ], [ 'provider_id' => $wrong_city ] );

		$result = ( new SqlSearchProvider() )->search( new SearchQuery( cityId: 5, q: 'ناحن' ) );
		$ids    = array_map( 'intval', array_column( $result->rows, 'provider_id' ) );

		$this->assertContains( $right_city, $ids );
		$this->assertNotContains( $wrong_city, $ids, 'A synonym-expanded text match must still AND with city_id, not bypass it.' );
	}
}
