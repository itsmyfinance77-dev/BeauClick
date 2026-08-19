<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\WishlistController;
use BeauClick\Marketplace\Wishlist\WishlistService;
use WP_REST_Request;
use WP_UnitTestCase;

final class WishlistControllerTest extends WP_UnitTestCase {

	private function make_provider(): int {
		$owner = self::factory()->user->create();
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner ] );
	}

	// 1. A logged-in customer can add a real provider to their own wishlist.
	public function test_a_logged_in_customer_can_add_a_real_provider(): void {
		$customer_id = self::factory()->user->create();
		$provider_id = $this->make_provider();
		wp_set_current_user( $customer_id );

		$request = new WP_REST_Request( 'POST', "/beauclick/v1/marketplace/wishlist/{$provider_id}" );
		$request->set_param( 'provider_id', $provider_id );

		$response = ( new WishlistController() )->add( $request );
		$this->assertSame( [ 'wishlisted' => true ], $response->get_data()['data'] );
		$this->assertTrue( ( new WishlistService() )->contains( $customer_id, $provider_id ) );
	}

	// 2. Adding a non-existent/non-provider id is refused with a real 404, never silently accepted.
	public function test_adding_a_nonexistent_provider_is_refused(): void {
		wp_set_current_user( self::factory()->user->create() );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/wishlist/999999' );
		$request->set_param( 'provider_id', 999999 );

		$response = ( new WishlistController() )->add( $request );
		$this->assertSame( 404, $response->get_status() );
	}

	// 3. A customer can remove a real item from their own wishlist.
	public function test_a_customer_can_remove_an_item(): void {
		$customer_id = self::factory()->user->create();
		$provider_id = $this->make_provider();
		( new WishlistService() )->add( $customer_id, $provider_id );
		wp_set_current_user( $customer_id );

		$request = new WP_REST_Request( 'DELETE', "/beauclick/v1/marketplace/wishlist/{$provider_id}" );
		$request->set_param( 'provider_id', $provider_id );

		$response = ( new WishlistController() )->remove( $request );
		$this->assertSame( [ 'wishlisted' => false ], $response->get_data()['data'] );
		$this->assertFalse( ( new WishlistService() )->contains( $customer_id, $provider_id ) );
	}

	// 4. index() returns real provider data for a real, still-published provider.
	public function test_index_returns_real_provider_data(): void {
		$customer_id = self::factory()->user->create();
		$provider_id = $this->make_provider();
		wp_update_post( [ 'ID' => $provider_id, 'post_title' => 'سالن آرایش تست' ] );
		( new WishlistService() )->add( $customer_id, $provider_id );
		wp_set_current_user( $customer_id );

		$list = ( new WishlistController() )->index()->get_data()['data'];
		$this->assertCount( 1, $list );
		$this->assertSame( $provider_id, $list[0]['id'] );
		$this->assertSame( 'سالن آرایش تست', $list[0]['name'] );
		$this->assertTrue( $list[0]['available'] );
	}

	// 5. A wishlisted provider that later gets unpublished is still reported (id + available:false), not silently dropped.
	public function test_an_unpublished_wishlisted_provider_is_reported_as_unavailable_not_dropped(): void {
		$customer_id = self::factory()->user->create();
		$provider_id = $this->make_provider();
		( new WishlistService() )->add( $customer_id, $provider_id );
		wp_update_post( [ 'ID' => $provider_id, 'post_status' => 'draft' ] );
		wp_set_current_user( $customer_id );

		$list = ( new WishlistController() )->index()->get_data()['data'];
		$this->assertCount( 1, $list );
		$this->assertFalse( $list[0]['available'] );
	}

	// 6. Isolation: one customer's wishlist listing never includes another customer's items.
	public function test_index_is_isolated_to_the_current_customer(): void {
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$provider_id = $this->make_provider();
		( new WishlistService() )->add( $customer_b, $provider_id );

		wp_set_current_user( $customer_a );
		$this->assertCount( 0, ( new WishlistController() )->index()->get_data()['data'] );
	}

	// 7. A logged-out visitor is refused (401) at the permission-callback layer.
	public function test_a_logged_out_visitor_cannot_add_to_a_wishlist(): void {
		wp_set_current_user( 0 );
		$this->assertInstanceOf( \WP_Error::class, ( new WishlistController() )->require_login() );
	}
}
