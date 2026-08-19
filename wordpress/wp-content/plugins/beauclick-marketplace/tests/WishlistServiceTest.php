<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\Wishlist\WishlistService;
use WP_UnitTestCase;

final class WishlistServiceTest extends WP_UnitTestCase {

	// 1. Adding a provider makes it appear in the customer's own list.
	public function test_add_makes_the_provider_appear_in_the_customers_list(): void {
		$service = new WishlistService();
		$service->add( 10, 501 );

		$this->assertSame( [ 501 ], $service->provider_ids_for( 10 ) );
		$this->assertTrue( $service->contains( 10, 501 ) );
	}

	// 2. Adding the same provider twice is a harmless no-op -- never a duplicate row.
	public function test_adding_the_same_provider_twice_is_idempotent(): void {
		global $wpdb;
		$service = new WishlistService();
		$service->add( 11, 502 );
		$service->add( 11, 502 );

		$this->assertSame( [ 502 ], $service->provider_ids_for( 11 ) );
		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_wishlist_items WHERE customer_id = %d", 11 ) );
		$this->assertSame( 1, $count );
	}

	// 3. Removing an item takes it out of the list, and removing a never-added item is a harmless no-op.
	public function test_remove_takes_the_item_out_of_the_list(): void {
		$service = new WishlistService();
		$service->add( 12, 503 );
		$service->remove( 12, 503 );

		$this->assertSame( [], $service->provider_ids_for( 12 ) );
		$this->assertFalse( $service->contains( 12, 503 ) );

		// Removing again (already gone) must not error or behave differently.
		$service->remove( 12, 503 );
		$this->assertSame( [], $service->provider_ids_for( 12 ) );
	}

	// 4. Each customer's own list is fully isolated from every other customer's.
	public function test_wishlists_are_isolated_per_customer(): void {
		$service = new WishlistService();
		$service->add( 20, 601 );
		$service->add( 21, 602 );

		$this->assertSame( [ 601 ], $service->provider_ids_for( 20 ) );
		$this->assertSame( [ 602 ], $service->provider_ids_for( 21 ) );
		$this->assertFalse( $service->contains( 20, 602 ) );
	}

	// 5. Most-recently-added provider is listed first.
	public function test_provider_ids_are_returned_most_recently_added_first(): void {
		$service = new WishlistService();
		$service->add( 30, 701 );
		$service->add( 30, 702 );
		$service->add( 30, 703 );

		$this->assertSame( [ 703, 702, 701 ], $service->provider_ids_for( 30 ) );
	}
}
