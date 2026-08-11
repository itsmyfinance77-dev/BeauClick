<?php
declare( strict_types=1 );

namespace BeauClick\AI\Tests;

use BeauClick\AI\RuleBasedProvider;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class RuleBasedProviderTest extends WP_UnitTestCase {

	private function make_service( int $provider_id, string $title, int $specialty_id, int $price ): int {
		$service_id = self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id, 'post_title' => $title ]
		);
		wp_set_post_terms( $service_id, [ $specialty_id ], Registrar::SPECIALTY );
		update_post_meta( $service_id, '_bc_price', $price );
		return $service_id;
	}

	private function make_product( string $name, int $category_id, int $price ): int {
		$product = new \WC_Product_Simple();
		$product->set_name( $name );
		$product->set_regular_price( (string) $price );
		$product->set_price( (string) $price );
		$product->set_catalog_visibility( 'visible' );
		$product->set_status( 'publish' );
		$product->set_category_ids( [ $category_id ] );
		$product->save();
		return $product->get_id();
	}

	public function test_a_medical_concern_short_circuits_to_a_cautious_reply_with_no_recommendations(): void {
		$provider = new RuleBasedProvider();
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'فکر کنم پوستم عفونت کرده' ] ], [] );

		$this->assertSame( [], $response->recommendations );
		$this->assertStringContainsString( 'پزشک', $response->reply );
	}

	public function test_a_product_over_budget_is_excluded(): void {
		$category = wp_insert_term( 'مراقبت پوست', 'product_cat' );
		$category_id = (int) $category['term_id'];
		$cheap = $this->make_product( 'کرم ارزان', $category_id, 100000 );
		$expensive = $this->make_product( 'کرم گران', $category_id, 3000000 );

		$provider = new RuleBasedProvider();
		$response = $provider->chat(
			[ [ 'role' => 'user', 'content' => 'برای مراقبت پوست با بودجه ۵۰۰ هزار تومان محصول می‌خوام' ] ],
			[]
		);

		$ids = array_column( $response->recommendations, 'id' );
		$this->assertContains( $cheap, $ids );
		$this->assertNotContains( $expensive, $ids, 'A product priced above the stated budget must never be recommended.' );
	}

	public function test_every_recommendation_carries_a_reason_grounded_in_real_data(): void {
		$category = wp_insert_term( 'میکاپ', 'product_cat' );
		$category_id = (int) $category['term_id'];
		$this->make_product( 'ست میکاپ', $category_id, 500000 );

		$provider = new RuleBasedProvider();
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'یه محصول میکاپ می‌خوام' ] ], [] );

		$this->assertNotEmpty( $response->recommendations );
		foreach ( $response->recommendations as $rec ) {
			$this->assertArrayHasKey( 'reason', $rec );
			$this->assertNotSame( '', $rec['reason'] );
		}
	}

	public function test_a_service_recommendation_requires_its_parent_provider_to_be_published(): void {
		$specialty = wp_insert_term( 'میکاپ', 'bc_specialty' );
		$specialty_id = (int) $specialty['term_id'];
		$draft_provider = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'draft' ] );
		$orphan_service = $this->make_service( $draft_provider, 'میکاپ عروس', $specialty_id, 2000000 );

		$provider = new RuleBasedProvider();
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'دنبال میکاپ هستم' ] ], [] );

		$service_ids = array_column(
			array_filter( $response->recommendations, static fn ( array $r ) => 'service' === $r['type'] ),
			'id'
		);
		$this->assertNotContains( $orphan_service, $service_ids, 'A service whose parent provider is not published must never be recommended.' );
	}

	/**
	 * Found via live browser verification: a hair-color service from an
	 * Isfahan-based provider surfaced for an explicit "in Yazd" request,
	 * because find_services() filtered by specialty/budget but never by
	 * city (services carry no city of their own -- only their parent
	 * provider does). Fixed by checking the parent's _bc_city_id.
	 */
	public function test_a_service_from_a_provider_in_a_different_city_is_excluded_when_a_city_is_named(): void {
		global $wpdb;
		$specialty = wp_insert_term( 'رنگ مو', 'bc_specialty' );
		$specialty_id = (int) $specialty['term_id'];

		$wpdb->insert( $wpdb->prefix . 'bc_cities', [ 'province_id' => 1, 'name_fa' => 'یزد', 'slug' => 'yazd-' . wp_rand(), 'is_launched' => 1 ], [ '%d', '%s', '%s', '%d' ] );
		$yazd_id = $wpdb->insert_id;
		$wpdb->insert( $wpdb->prefix . 'bc_cities', [ 'province_id' => 1, 'name_fa' => 'اصفهان', 'slug' => 'isfahan-' . wp_rand(), 'is_launched' => 1 ], [ '%d', '%s', '%s', '%d' ] );
		$isfahan_id = $wpdb->insert_id;

		$yazd_provider = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		update_post_meta( $yazd_provider, '_bc_city_id', $yazd_id );
		$yazd_service = $this->make_service( $yazd_provider, 'رنگ مو یزد', $specialty_id, 1000000 );

		$isfahan_provider = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		update_post_meta( $isfahan_provider, '_bc_city_id', $isfahan_id );
		$isfahan_service = $this->make_service( $isfahan_provider, 'رنگ مو اصفهان', $specialty_id, 1000000 );

		$provider = new RuleBasedProvider();
		$response = $provider->chat(
			[ [ 'role' => 'user', 'content' => 'دنبال رنگ مو هستم' ] ],
			[ 'specialtyIds' => [ $specialty_id ], 'cityId' => $yazd_id ]
		);

		$service_ids = array_column(
			array_filter( $response->recommendations, static fn ( array $r ) => 'service' === $r['type'] ),
			'id'
		);
		$this->assertContains( $yazd_service, $service_ids );
		$this->assertNotContains( $isfahan_service, $service_ids, 'A service from a provider in a different city than the one named must never be recommended.' );
	}

	public function test_an_impossible_request_gets_an_honest_no_match_reply_not_a_fabrication(): void {
		$provider = new RuleBasedProvider();
		$response = $provider->chat(
			[ [ 'role' => 'user', 'content' => 'دنبال یک متخصص کاشت مو در سیاره مریخ با بودجه ۱ تومان هستم و باید بودا باشد' ] ],
			[ 'specialtyIds' => [ 999999 ] ]
		);

		$this->assertSame( [], $response->recommendations );
		$this->assertNotSame( '', trim( $response->reply ) );
	}

	public function test_no_recognizable_signal_asks_a_clarifying_question(): void {
		$provider = new RuleBasedProvider();
		$response = $provider->chat( [ [ 'role' => 'user', 'content' => 'سلام' ] ], [] );

		$this->assertSame( [], $response->recommendations );
	}
}
