<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\PortfolioController;
use WP_REST_Request;
use WP_UnitTestCase;

final class PortfolioControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	/** A real, valid 1x1 PNG written to a real temp file, matching what a genuine browser upload's $_FILES structure looks like. */
	private function fake_uploaded_image(): array {
		$png_bytes = base64_decode( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' );
		$tmp_path  = wp_tempnam( 'bc-portfolio-test.png' );
		file_put_contents( $tmp_path, $png_bytes );

		return [
			'name'     => 'test.png',
			'type'     => 'image/png',
			'tmp_name' => $tmp_path,
			'error'    => 0,
			'size'     => strlen( $png_bytes ),
		];
	}

	protected function tearDown(): void {
		$_FILES = [];
		parent::tearDown();
	}

	/**
	 * 1. The full "real uploaded image" happy path (`media_handle_upload()`
	 * actually succeeding) is deliberately NOT unit-tested here: WordPress
	 * core's own `_wp_handle_upload()` calls PHP's `is_uploaded_file()`,
	 * which only ever returns true for a file PHP's own request handler
	 * genuinely received via a multipart HTTP POST -- a real, disclosed
	 * PHPUnit/CLI limitation (confirmed by reading `_wp_handle_upload()`
	 * itself), not something this controller, or a test double, can fake
	 * without patching WordPress core's own upload internals. Every other
	 * piece of this controller's own logic (ownership, validation, the
	 * cap, listing, deletion) is fully covered below; the real upload path
	 * itself is verified live (see this step's Live QA notes) with a real
	 * browser-submitted file.
	 */

	// 2. Without a profile yet, adding a portfolio item is refused with a real 404.
	public function test_adding_a_portfolio_item_with_no_profile_yet_is_refused(): void {
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'bc_professional' ] ) );

		$_FILES['image'] = $this->fake_uploaded_image();
		$request          = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/my/portfolio' );
		$request->set_file_params( $_FILES );

		$response = ( new PortfolioController() )->create( $request );
		$this->assertSame( 404, $response->get_status() );
	}

	// 3. A request with no image file at all is refused, never silently creating an image-less item.
	public function test_adding_a_portfolio_item_with_no_image_is_refused(): void {
		$owner_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$this->make_provider( $owner_id );
		wp_set_current_user( $owner_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/my/portfolio' );
		$response = ( new PortfolioController() )->create( $request );

		$this->assertSame( 422, $response->get_status() );
	}

	// 4. index() lists only the current professional's own real items.
	public function test_index_lists_only_the_current_professionals_own_items(): void {
		$owner_a = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$owner_b = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_a = $this->make_provider( $owner_a );
		$provider_b = $this->make_provider( $owner_b );
		self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_a, 'post_parent' => $provider_a, 'post_title' => 'کار الف' ] );
		self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_b, 'post_parent' => $provider_b, 'post_title' => 'کار ب' ] );

		wp_set_current_user( $owner_a );
		$list = ( new PortfolioController() )->index()->get_data()['data'];

		$this->assertCount( 1, $list );
		$this->assertSame( 'کار الف', $list[0]['title'] );
	}

	// 5. Ownership: a professional cannot delete another professional's portfolio item.
	public function test_a_professional_cannot_delete_another_professionals_item(): void {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$attacker_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_id = $this->make_provider( $owner_id );
		$item_id     = self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_parent' => $provider_id ] );

		wp_set_current_user( $attacker_id );
		$controller = new PortfolioController();
		$request    = new WP_REST_Request( 'DELETE', "/beauclick/v1/marketplace/my/portfolio/{$item_id}" );
		$request->set_param( 'id', $item_id );

		$this->assertInstanceOf( \WP_Error::class, $controller->can_edit_item( $request ) );
	}

	// 6. The owner can delete their own item, and it disappears from their own listing.
	public function test_the_owner_can_delete_their_own_item(): void {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_id = $this->make_provider( $owner_id );
		$item_id     = self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_parent' => $provider_id ] );
		wp_set_current_user( $owner_id );

		$controller = new PortfolioController();
		$request    = new WP_REST_Request( 'DELETE', "/beauclick/v1/marketplace/my/portfolio/{$item_id}" );
		$request->set_param( 'id', $item_id );
		$controller->delete( $request );

		$this->assertCount( 0, $controller->index()->get_data()['data'] );
	}

	// 7. An admin (bc_manage_platform) can delete anyone's portfolio item.
	public function test_an_admin_can_delete_any_portfolio_item(): void {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$admin_id    = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$provider_id = $this->make_provider( $owner_id );
		$item_id     = self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_parent' => $provider_id ] );

		wp_set_current_user( $admin_id );
		$controller = new PortfolioController();
		$request    = new WP_REST_Request( 'DELETE', "/beauclick/v1/marketplace/my/portfolio/{$item_id}" );
		$request->set_param( 'id', $item_id );

		$this->assertTrue( $controller->can_edit_item( $request ) );
	}

	// 8. The per-provider cap refuses a new item once the maximum is reached, before ever touching the upload.
	public function test_create_is_refused_once_the_per_provider_cap_is_reached(): void {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_id = $this->make_provider( $owner_id );
		for ( $i = 0; $i < 24; $i++ ) {
			self::factory()->post->create( [ 'post_type' => Registrar::PORTFOLIO_ITEM, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_parent' => $provider_id ] );
		}
		wp_set_current_user( $owner_id );

		$_FILES['image'] = $this->fake_uploaded_image();
		$request          = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/my/portfolio' );
		$request->set_file_params( $_FILES );

		$response = ( new PortfolioController() )->create( $request );
		$this->assertSame( 422, $response->get_status() );
		$this->assertCount( 24, ( new PortfolioController() )->index()->get_data()['data'], 'A refused attempt must never have created a 25th item.' );
	}
}
