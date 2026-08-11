<?php
declare( strict_types=1 );

namespace BeauClick\Payments\Tests;

use BeauClick\Payments\Product\ServiceProductSync;
use WP_UnitTestCase;

final class ServiceProductSyncTest extends WP_UnitTestCase {

	private function make_service( string $title, int $price ): int {
		$service_id = self::factory()->post->create( [ 'post_type' => 'bc_service', 'post_title' => $title, 'post_status' => 'publish' ] );
		update_post_meta( $service_id, '_bc_price', $price );
		return $service_id;
	}

	public function test_syncing_creates_a_hidden_virtual_product(): void {
		$service_id = $this->make_service( 'میکاپ عروس', 2500000 );

		$product = ( new ServiceProductSync() )->sync( $service_id );

		$this->assertTrue( $product->is_virtual() );
		$this->assertSame( 'hidden', $product->get_catalog_visibility(), 'A service-backed product must never appear in Shop browse/search.' );
		$this->assertSame( 2500000.0, (float) $product->get_price() );
		$this->assertSame( 'میکاپ عروس', $product->get_name() );
	}

	public function test_syncing_twice_reuses_the_same_product_instead_of_duplicating(): void {
		$service_id = $this->make_service( 'میکاپ عروس', 2500000 );

		$first  = ( new ServiceProductSync() )->sync( $service_id );
		$second = ( new ServiceProductSync() )->sync( $service_id );

		$this->assertSame( $first->get_id(), $second->get_id() );
	}

	public function test_syncing_after_a_price_change_updates_the_linked_product(): void {
		$service_id = $this->make_service( 'میکاپ عروس', 2500000 );
		( new ServiceProductSync() )->sync( $service_id );

		update_post_meta( $service_id, '_bc_price', 2800000 );
		$product = ( new ServiceProductSync() )->sync( $service_id );

		$this->assertSame( 2800000.0, (float) $product->get_price() );
	}
}
