<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Auth\Phone\PhoneNormalizer;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\StaffController;
use WP_REST_Request;
use WP_UnitTestCase;

final class StaffControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::BUSINESS, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function index_phone( int $user_id, string $raw_phone ): void {
		global $wpdb;
		$wpdb->insert( $wpdb->prefix . 'bc_phone_index', [ 'phone_canonical' => PhoneNormalizer::normalize( $raw_phone ), 'user_id' => $user_id, 'verified_at' => current_time( 'mysql' ), 'created_at' => current_time( 'mysql' ) ] );
	}

	public function test_the_owner_can_add_and_list_staff(): void {
		$owner_id = self::factory()->user->create();
		$this->make_provider( $owner_id );
		$staff_id = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		wp_set_current_user( $owner_id );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/my/staff' );
		$request->set_param( 'phone', '09121234567' );

		$response = ( new StaffController() )->add_staff( $request );
		$this->assertSame( 201, $response->get_status() );

		$list = ( new StaffController() )->list_staff()->get_data()['data'];
		$this->assertCount( 1, $list );
		$this->assertSame( $staff_id, $list[0]['userId'] );
	}

	// 25/26. Customer/professional isolation -- a staff member cannot manage the staff list themselves.
	public function test_a_staff_member_cannot_manage_the_staff_list(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );
		( new \BeauClick\Marketplace\Staff\StaffService() )->add( $business_id, '09121234567', $owner_id );

		wp_set_current_user( $staff_id );
		$this->assertInstanceOf( \WP_Error::class, ( new StaffController() )->can_manage_staff(), 'An authorized staff member must not be able to manage the staff list itself in this minimal model -- only the genuine owner may.' );
	}

	public function test_an_unrelated_user_cannot_manage_someone_elses_staff(): void {
		$owner_id = self::factory()->user->create();
		$this->make_provider( $owner_id );
		$stranger = self::factory()->user->create();

		wp_set_current_user( $stranger );
		$this->assertInstanceOf( \WP_Error::class, ( new StaffController() )->can_manage_staff() );
	}

	public function test_owner_can_remove_a_staff_member(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );
		( new \BeauClick\Marketplace\Staff\StaffService() )->add( $business_id, '09121234567', $owner_id );

		wp_set_current_user( $owner_id );
		$request = new WP_REST_Request( 'DELETE', "/beauclick/v1/marketplace/my/staff/{$staff_id}" );
		$request->set_param( 'user_id', $staff_id );

		$response = ( new StaffController() )->remove_staff( $request );
		$this->assertSame( 200, $response->get_status() );
		$this->assertTrue( $response->get_data()['data']['removed'] );
		$this->assertFalse( ( new \BeauClick\Marketplace\Staff\StaffService() )->is_active_staff( $business_id, $staff_id ) );
	}

	public function test_error_codes_are_persian_and_correctly_mapped(): void {
		$owner_id = self::factory()->user->create();
		$this->make_provider( $owner_id );
		wp_set_current_user( $owner_id );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/marketplace/my/staff' );
		$request->set_param( 'phone', '09129999999' ); // Not a real registered user.

		$response = ( new StaffController() )->add_staff( $request );
		$this->assertSame( 404, $response->get_status() );
		$this->assertSame( 'bc_user_not_found', $response->get_data()['error']['code'] );
		$this->assertNotEmpty( $response->get_data()['error']['message'] );
	}
}
