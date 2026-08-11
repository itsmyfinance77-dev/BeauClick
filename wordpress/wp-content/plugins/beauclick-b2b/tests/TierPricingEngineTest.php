<?php
declare( strict_types=1 );

namespace BeauClick\B2B\Tests;

use BeauClick\B2B\Business\BusinessAccountService;
use BeauClick\B2B\Pricing\TierPricingEngine;
use WP_UnitTestCase;

final class TierPricingEngineTest extends WP_UnitTestCase {

	private function make_product( int $price = 100000 ): int {
		$product = new \WC_Product_Simple();
		$product->set_name( 'Test Product' );
		$product->set_regular_price( (string) $price );
		$product->set_price( (string) $price );
		$product->save();
		return $product->get_id();
	}

	private function seed_tiers( int $product_id ): void {
		( new TierPricingEngine() )->set_tiers(
			$product_id,
			[
				[ 'min_qty' => 1, 'max_qty' => 9, 'price' => 100000 ],
				[ 'min_qty' => 10, 'max_qty' => 49, 'price' => 90000 ],
				[ 'min_qty' => 50, 'max_qty' => 99, 'price' => 80000, 'is_recommended' => true ],
				[ 'min_qty' => 100, 'max_qty' => null, 'price' => 70000 ],
			]
		);
	}

	public function test_price_for_quantity_matches_the_correct_tier(): void {
		$product_id = $this->make_product();
		$this->seed_tiers( $product_id );
		$engine = new TierPricingEngine();

		$this->assertSame( 100000, $engine->price_for_quantity( $product_id, 1 ) );
		$this->assertSame( 100000, $engine->price_for_quantity( $product_id, 9 ) );
		$this->assertSame( 90000, $engine->price_for_quantity( $product_id, 10 ) );
		$this->assertSame( 90000, $engine->price_for_quantity( $product_id, 49 ) );
		$this->assertSame( 80000, $engine->price_for_quantity( $product_id, 50 ) );
		$this->assertSame( 80000, $engine->price_for_quantity( $product_id, 99 ) );
		$this->assertSame( 70000, $engine->price_for_quantity( $product_id, 100 ) );
		$this->assertSame( 70000, $engine->price_for_quantity( $product_id, 100000 ), 'The open-ended top tier (max_qty=null) must match any quantity at or above its min_qty.' );
	}

	public function test_moq_is_the_lowest_tiers_minimum(): void {
		$product_id = $this->make_product();
		$this->seed_tiers( $product_id );
		$this->assertSame( 1, ( new TierPricingEngine() )->moq( $product_id ) );
	}

	public function test_a_product_with_no_tiers_has_no_moq_and_no_price_match(): void {
		$product_id = $this->make_product();
		$engine     = new TierPricingEngine();

		$this->assertNull( $engine->moq( $product_id ) );
		$this->assertNull( $engine->price_for_quantity( $product_id, 10 ) );
		$this->assertFalse( $engine->has_tiers( $product_id ) );
	}

	public function test_setting_tiers_twice_replaces_rather_than_duplicates(): void {
		$product_id = $this->make_product();
		$engine     = new TierPricingEngine();

		$this->seed_tiers( $product_id );
		$this->seed_tiers( $product_id );

		$this->assertCount( 4, $engine->get_tiers( $product_id ), 'Re-seeding tiers must replace the old set, not append duplicates.' );
	}

	public function test_moq_validation_blocks_quantities_below_the_lowest_tier(): void {
		$product_id = $this->make_product();
		( new TierPricingEngine() )->set_tiers( $product_id, [ [ 'min_qty' => 20, 'max_qty' => null, 'price' => 80000 ] ] );

		$user_id = self::factory()->user->create();
		( new BusinessAccountService() )->approve( ( new BusinessAccountService() )->apply( $user_id, 'Test Salon' ) );
		wp_set_current_user( $user_id );

		$engine = new TierPricingEngine();
		$this->assertFalse( $engine->validate_moq( true, $product_id, 5 ), 'A quantity below the product\'s MOQ must be rejected for an approved B2B buyer.' );
		$this->assertTrue( $engine->validate_moq( true, $product_id, 20 ) );
	}

	public function test_moq_does_not_block_a_non_approved_buyer(): void {
		$product_id = $this->make_product();
		// MOQ is 20 here — meaningful only if a *non*-approved buyer adding
		// far fewer units (1) is still let through, proving wholesale rules
		// don't leak onto ordinary retail customers.
		( new TierPricingEngine() )->set_tiers( $product_id, [ [ 'min_qty' => 20, 'max_qty' => null, 'price' => 80000 ] ] );

		$regular_customer = self::factory()->user->create();
		wp_set_current_user( $regular_customer );

		$engine = new TierPricingEngine();
		$this->assertTrue( $engine->validate_moq( true, $product_id, 1 ), 'A non-approved buyer must never be MOQ-blocked on a product that only has a wholesale MOQ — retail purchases are unaffected.' );
	}
}
