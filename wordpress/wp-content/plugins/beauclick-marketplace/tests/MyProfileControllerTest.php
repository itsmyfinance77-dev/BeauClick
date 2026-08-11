<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\MyProfileController;
use WP_UnitTestCase;

final class MyProfileControllerTest extends WP_UnitTestCase {

	private function make_provider_with_service( int $owner_id ): array {
		$provider_id = self::factory()->post->create(
			[ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ]
		);
		$service_id = self::factory()->post->create(
			[ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_parent' => $provider_id ]
		);
		return [ $provider_id, $service_id ];
	}

	public function test_a_professional_can_edit_their_own_service(): void {
		$owner_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		[ , $service_id ] = $this->make_provider_with_service( $owner_id );
		wp_set_current_user( $owner_id );

		$controller = new MyProfileController();
		$request    = new \WP_REST_Request( 'PATCH', "/beauclick/v1/marketplace/my/services/{$service_id}" );
		$request->set_param( 'id', $service_id );

		$this->assertTrue( $controller->can_edit_service( $request ) );
	}

	public function test_a_professional_cannot_edit_another_professionals_service(): void {
		$owner_id   = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$attacker_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		[ , $service_id ] = $this->make_provider_with_service( $owner_id );
		wp_set_current_user( $attacker_id );

		$controller = new MyProfileController();
		$request    = new \WP_REST_Request( 'PATCH', "/beauclick/v1/marketplace/my/services/{$service_id}" );
		$request->set_param( 'id', $service_id );

		$result = $controller->can_edit_service( $request );
		$this->assertInstanceOf( \WP_Error::class, $result, 'A professional must never be able to edit another professional\'s service, even though both share the bc_manage_own_services capability.' );
	}

	public function test_admin_can_edit_any_service(): void {
		$owner_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		[ , $service_id ] = $this->make_provider_with_service( $owner_id );
		wp_set_current_user( $admin_id );

		$controller = new MyProfileController();
		$request    = new \WP_REST_Request( 'PATCH', "/beauclick/v1/marketplace/my/services/{$service_id}" );
		$request->set_param( 'id', $service_id );

		$this->assertTrue( $controller->can_edit_service( $request ) );
	}

	public function test_updating_a_services_price_resyncs_the_parent_providers_index_price_from(): void {
		global $wpdb;
		$owner_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		[ $provider_id, $service_id ] = $this->make_provider_with_service( $owner_id );
		update_post_meta( $service_id, '_bc_price', 100000 );
		( new \BeauClick\Marketplace\Search\Indexer() )->sync( $provider_id, Registrar::PROFESSIONAL );

		wp_set_current_user( $owner_id );
		$controller = new MyProfileController();
		$request    = new \WP_REST_Request( 'PATCH', "/beauclick/v1/marketplace/my/services/{$service_id}" );
		$request->set_param( 'id', $service_id );
		$request->set_param( 'price', 250000 );
		$controller->update_service( $request );

		$price_from = $wpdb->get_var( $wpdb->prepare( "SELECT price_from FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ) );
		$this->assertSame( '250000', $price_from );
	}

	public function test_a_professional_with_no_profile_yet_sees_an_empty_service_list_not_an_error(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		wp_set_current_user( $user_id );

		$controller = new MyProfileController();
		$response   = $controller->list_services();

		$this->assertSame( [], $response->get_data()['data'] );
	}
}
