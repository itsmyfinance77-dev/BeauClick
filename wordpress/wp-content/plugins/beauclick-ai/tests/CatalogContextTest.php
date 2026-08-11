<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\CatalogContext;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Search\Indexer;
use WP_UnitTestCase;

/**
 * V2.0 Step 2: AnthropicProvider can only ever recommend a catalog id it was
 * shown in the prompt -- these tests cover the same real-data-only guarantee
 * for CatalogContext::summary() that AssistantServiceTest already covers for
 * RuleBasedProvider + validate_recommendations().
 */
final class CatalogContextTest extends WP_UnitTestCase {

	private function make_provider( string $name, int $specialty_id ): int {
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_title' => $name ] );
		wp_set_post_terms( $provider_id, [ $specialty_id ], Registrar::SPECIALTY );
		( new Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );
		return $provider_id;
	}

	private function make_service( int $provider_id, string $title, int $specialty_id, int $price ): int {
		$service_id = self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id, 'post_title' => $title ]
		);
		wp_set_post_terms( $service_id, [ $specialty_id ], Registrar::SPECIALTY );
		update_post_meta( $service_id, '_bc_price', $price );
		return $service_id;
	}

	private function make_visible_product( string $name, string $category_slug, int $price ): int {
		$product = new \WC_Product_Simple();
		$product->set_name( $name );
		$product->set_regular_price( (string) $price );
		$product->set_price( (string) $price );
		$product->set_catalog_visibility( 'visible' );
		$product->set_status( 'publish' );
		$term = get_term_by( 'slug', $category_slug, 'product_cat' ) ?: wp_insert_term( $category_slug, 'product_cat' );
		$term_id = is_array( $term ) ? (int) $term['term_id'] : (int) $term->term_id;
		$product->set_category_ids( [ $term_id ] );
		$product->save();
		return $product->get_id();
	}

	public function test_summary_includes_a_matching_provider_service_and_product(): void {
		$specialty = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $specialty['term_id'];
		$provider_id = $this->make_provider( 'سالن تست', $specialty_id );
		$service_id  = $this->make_service( $provider_id, 'میکاپ عروس', $specialty_id, 2000000 );
		$category    = get_term_by( 'name', 'مراقبت پوست', 'product_cat' ) ?: wp_insert_term( 'مراقبت پوست', 'product_cat' );
		$category_id = is_array( $category ) ? (int) $category['term_id'] : (int) $category->term_id;
		$product_id  = $this->make_visible_product( 'کرم مرطوب‌کننده', 'مراقبت-پوست', 150000 );
		wp_set_object_terms( $product_id, [ $category_id ], 'product_cat', true );

		$summary = ( new CatalogContext() )->summary( [ 'specialtyIds' => [ $specialty_id ], 'productCategoryIds' => [ $category_id ] ] );

		$types = array_column( $summary, 'type' );
		$this->assertContains( 'provider', $types );
		$this->assertContains( 'service', $types );
		$this->assertContains( 'product', $types );

		$ids = array_column( $summary, 'id' );
		$this->assertContains( $provider_id, $ids );
		$this->assertContains( $service_id, $ids );
		$this->assertContains( $product_id, $ids );
	}

	public function test_summary_excludes_a_hidden_catalog_visibility_product(): void {
		$category    = wp_insert_term( 'دسته-مخفی-تست', 'product_cat' );
		$category_id = (int) $category['term_id'];

		$hidden = new \WC_Product_Simple();
		$hidden->set_name( 'محصول مخفی' );
		$hidden->set_regular_price( '100000' );
		$hidden->set_price( '100000' );
		$hidden->set_catalog_visibility( 'hidden' );
		$hidden->set_status( 'publish' );
		$hidden->set_category_ids( [ $category_id ] );
		$hidden->save();

		$summary = ( new CatalogContext() )->summary( [ 'productCategoryIds' => [ $category_id ] ] );

		$ids = array_column( $summary, 'id' );
		$this->assertNotContains( $hidden->get_id(), $ids, 'A hidden booking-only product must never be offered to the model as a recommendable catalog item.' );
	}

	public function test_summary_is_empty_when_no_context_signals_are_known(): void {
		$this->assertSame( [], ( new CatalogContext() )->summary( [] ) );
	}

	public function test_summary_excludes_a_service_from_a_provider_in_a_different_city(): void {
		global $wpdb;
		$specialty = wp_insert_term( 'رنگ مو', 'bc_specialty' );
		$specialty_id = (int) $specialty['term_id'];

		$wpdb->insert( $wpdb->prefix . 'bc_cities', [ 'province_id' => 1, 'name_fa' => 'یزد', 'slug' => 'yazd-' . wp_rand(), 'is_launched' => 1 ], [ '%d', '%s', '%s', '%d' ] );
		$yazd_id = $wpdb->insert_id;
		$wpdb->insert( $wpdb->prefix . 'bc_cities', [ 'province_id' => 1, 'name_fa' => 'اصفهان', 'slug' => 'isfahan-' . wp_rand(), 'is_launched' => 1 ], [ '%d', '%s', '%s', '%d' ] );
		$isfahan_id = $wpdb->insert_id;

		$isfahan_provider = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		update_post_meta( $isfahan_provider, '_bc_city_id', $isfahan_id );
		$isfahan_service = $this->make_service( $isfahan_provider, 'رنگ مو اصفهان', $specialty_id, 1000000 );

		$summary = ( new CatalogContext() )->summary( [ 'specialtyIds' => [ $specialty_id ], 'cityId' => $yazd_id ] );

		$service_ids = array_column( array_filter( $summary, static fn ( array $r ) => 'service' === $r['type'] ), 'id' );
		$this->assertNotContains( $isfahan_service, $service_ids, 'An LLM provider must not even be offered an out-of-city service to recommend.' );
	}
}
