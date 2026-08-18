<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\Search\SynonymExpander;
use WP_UnitTestCase;

/** V2.4 Step 21 (Search & Discovery Evolution). */
final class SynonymExpanderTest extends WP_UnitTestCase {

	public function test_a_correctly_spelled_group_term_expands_to_its_group(): void {
		$expanded = SynonymExpander::expand( 'کاشت ناخن' );

		$this->assertContains( 'ناخن', $expanded );
		$this->assertContains( 'ناخن کار', $expanded );
		$this->assertNotContains( 'کاشت ناخن', $expanded, 'The original query term itself must not be repeated in the expansion.' );
	}

	/** The exact real-world typo example this step's own brief names. */
	public function test_a_known_common_typo_expands_to_the_correctly_spelled_terms(): void {
		$expanded = SynonymExpander::expand( 'کاشت ناحن' );

		$this->assertContains( 'کاشت ناخن', $expanded, 'A confirmed common خ/ح typo must still find the correctly-spelled service.' );
		$this->assertContains( 'ناخن', $expanded );
	}

	public function test_an_alternate_real_phrasing_expands_to_the_platform_term(): void {
		$expanded = SynonymExpander::expand( 'خدمات ناخن' );

		$this->assertContains( 'ناخن', $expanded );
	}

	public function test_a_query_with_no_curated_match_expands_to_nothing(): void {
		$this->assertSame( [], SynonymExpander::expand( 'یک عبارت کاملا نامرتبط' ) );
	}

	public function test_an_empty_query_expands_to_nothing(): void {
		$this->assertSame( [], SynonymExpander::expand( '' ) );
	}

	public function test_a_short_group_term_expands_to_longer_phrases_in_the_same_group(): void {
		$expanded = SynonymExpander::expand( 'میکاپ' );

		$this->assertContains( 'میکاپ عروس', $expanded );
		$this->assertContains( 'میکاپ مراسم', $expanded );
	}
}
