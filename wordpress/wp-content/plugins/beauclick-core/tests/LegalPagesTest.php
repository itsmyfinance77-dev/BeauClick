<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Content\LegalPages;
use WP_UnitTestCase;

final class LegalPagesTest extends WP_UnitTestCase {

	public function test_ensure_creates_every_expected_page(): void {
		LegalPages::ensure();

		foreach ( [ 'privacy-policy', 'refund_returns', 'terms', 'faq', 'contact', 'about' ] as $slug ) {
			$page = get_page_by_path( $slug, OBJECT, 'page' );
			$this->assertNotNull( $page, "Expected a page at slug \"{$slug}\" to exist after ensure()." );
			$this->assertNotEmpty( trim( (string) $page->post_content ), "Page \"{$slug}\" must have real content, not be left empty." );
		}
	}

	public function test_terms_page_is_created_but_never_published(): void {
		LegalPages::ensure();

		$terms = get_page_by_path( 'terms', OBJECT, 'page' );
		$this->assertSame( 'draft', $terms->post_status, 'Terms of Service must stay unpublished until its binding legal clauses are reviewed -- see the task\'s own "do not publish an unreviewed ToS" rule.' );
	}

	public function test_privacy_refund_faq_contact_about_are_published(): void {
		LegalPages::ensure();

		foreach ( [ 'privacy-policy', 'refund_returns', 'faq', 'contact', 'about' ] as $slug ) {
			$page = get_page_by_path( $slug, OBJECT, 'page' );
			$this->assertSame( 'publish', $page->post_status, "\"{$slug}\" is factually-grounded content and should be publicly reachable." );
		}
	}

	public function test_ensure_never_overwrites_content_an_admin_has_genuinely_written(): void {
		$id = self::factory()->post->create( [ 'post_type' => 'page', 'post_name' => 'privacy-policy', 'post_content' => 'متن واقعی که خودم نوشتم.', 'post_status' => 'publish' ] );

		LegalPages::ensure();

		$this->assertSame( 'متن واقعی که خودم نوشتم.', get_post( $id )->post_content, 'A page an admin has already written real content into must never be silently overwritten.' );
	}

	public function test_ensure_overwrites_the_stock_wordpress_privacy_draft(): void {
		self::factory()->post->create(
			[
				'post_type'    => 'page',
				'post_name'    => 'privacy-policy',
				'post_content' => '<p><strong class="privacy-policy-tutorial">Suggested text: </strong>Our website address is: http://example.com.</p>',
				'post_status'  => 'draft',
			]
		);

		LegalPages::ensure();

		$page = get_page_by_path( 'privacy-policy', OBJECT, 'page' );
		$this->assertStringNotContainsString( 'Suggested text', $page->post_content, 'The untouched WordPress-generated stub must be replaced with real content.' );
		$this->assertSame( 'publish', $page->post_status );
	}

	public function test_ensure_sets_wp_privacy_policy_page_option(): void {
		update_option( 'wp_page_for_privacy_policy', 0 );

		LegalPages::ensure();

		$page = get_page_by_path( 'privacy-policy', OBJECT, 'page' );
		$this->assertSame( $page->ID, (int) get_option( 'wp_page_for_privacy_policy' ), 'WordPress\'s own [privacy_policy] placeholder (used at checkout) only resolves once this option points at a real, published page.' );
	}

	public function test_ensure_never_overrides_a_deliberately_different_privacy_policy_choice(): void {
		$other_page_id = self::factory()->post->create( [ 'post_type' => 'page', 'post_title' => 'یک صفحه دیگر' ] );
		update_option( 'wp_page_for_privacy_policy', $other_page_id );

		LegalPages::ensure();

		$this->assertSame( $other_page_id, (int) get_option( 'wp_page_for_privacy_policy' ), 'An admin who already chose a different page for this setting must never be silently overridden.' );
	}

	public function test_ensure_trashes_only_the_genuine_stock_sample_page(): void {
		$sample_id = self::factory()->post->create( [ 'post_type' => 'page', 'post_title' => 'Sample Page', 'post_name' => 'sample-page', 'post_status' => 'publish' ] );

		LegalPages::ensure();

		$this->assertSame( 'trash', get_post_status( $sample_id ) );
	}

	public function test_ensure_never_trashes_a_page_an_admin_repurposed_at_the_same_slug(): void {
		$id = self::factory()->post->create( [ 'post_type' => 'page', 'post_title' => 'صفحه واقعی من', 'post_name' => 'sample-page', 'post_status' => 'publish' ] );

		LegalPages::ensure();

		$this->assertSame( 'publish', get_post_status( $id ), 'Only the exact stock "Sample Page" title/slug combination may be trashed -- a page an admin repurposed at the same slug must survive.' );
	}

	public function test_faq_content_is_valid_structured_json(): void {
		LegalPages::ensure();

		$faq = get_page_by_path( 'faq', OBJECT, 'page' );
		$decoded = json_decode( $faq->post_content, true );

		$this->assertIsArray( $decoded );
		$this->assertNotEmpty( $decoded );
		foreach ( $decoded as $item ) {
			$this->assertArrayHasKey( 'q', $item );
			$this->assertArrayHasKey( 'a', $item );
			$this->assertNotEmpty( $item['q'] );
			$this->assertNotEmpty( $item['a'] );
		}
	}

	public function test_ensure_is_idempotent(): void {
		LegalPages::ensure();
		$first_count = count( get_posts( [ 'post_type' => 'page', 'post_status' => 'any', 'numberposts' => -1 ] ) );

		LegalPages::ensure();
		$second_count = count( get_posts( [ 'post_type' => 'page', 'post_status' => 'any', 'numberposts' => -1 ] ) );

		$this->assertSame( $first_count, $second_count, 'Running ensure() twice must never create duplicate pages.' );
	}
}
