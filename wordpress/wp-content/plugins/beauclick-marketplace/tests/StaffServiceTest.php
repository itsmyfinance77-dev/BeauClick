<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Auth\Phone\PhoneNormalizer;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Staff\StaffService;
use WP_UnitTestCase;

final class StaffServiceTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::BUSINESS, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function index_phone( int $user_id, string $raw_phone ): string {
		global $wpdb;
		$canonical = PhoneNormalizer::normalize( $raw_phone );
		$wpdb->insert( $wpdb->prefix . 'bc_phone_index', [ 'phone_canonical' => $canonical, 'user_id' => $user_id, 'verified_at' => current_time( 'mysql' ), 'created_at' => current_time( 'mysql' ) ] );
		return $canonical;
	}

	public function test_adding_a_staff_member_by_phone_grants_active_status(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		$result = ( new StaffService() )->add( $business_id, '09121234567', $owner_id );

		$this->assertIsArray( $result );
		$this->assertTrue( ( new StaffService() )->is_active_staff( $business_id, $staff_id ) );
	}

	public function test_adding_the_owners_own_phone_is_rejected(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$this->index_phone( $owner_id, '09121234567' );

		$result = ( new StaffService() )->add( $business_id, '09121234567', $owner_id );

		$this->assertSame( StaffService::ERROR_IS_OWNER, $result );
	}

	public function test_adding_an_unregistered_phone_number_fails(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );

		$result = ( new StaffService() )->add( $business_id, '09129999999', $owner_id );

		$this->assertSame( StaffService::ERROR_NOT_FOUND, $result );
	}

	public function test_adding_the_same_staff_member_twice_is_rejected(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		( new StaffService() )->add( $business_id, '09121234567', $owner_id );
		$second = ( new StaffService() )->add( $business_id, '09121234567', $owner_id );

		$this->assertSame( StaffService::ERROR_ALREADY_STAFF, $second );
	}

	public function test_removing_a_staff_member_revokes_access(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		$service = new StaffService();
		$service->add( $business_id, '09121234567', $owner_id );
		$removed = $service->remove( $business_id, $staff_id );

		$this->assertTrue( $removed );
		$this->assertFalse( $service->is_active_staff( $business_id, $staff_id ) );
	}

	public function test_provider_ids_for_staff_user_resolves_the_correct_business(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$other_business = $this->make_provider( self::factory()->user->create() );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		( new StaffService() )->add( $business_id, '09121234567', $owner_id );

		$provider_ids = ( new StaffService() )->provider_ids_for_staff_user( $staff_id );

		$this->assertSame( [ $business_id ], $provider_ids );
		$this->assertNotContains( $other_business, $provider_ids );
	}

	// A user who was removed and later re-added must become active again (the UNIQUE(business_id,user_id) upsert path).
	public function test_re_adding_a_previously_removed_staff_member_works(): void {
		$owner_id    = self::factory()->user->create();
		$business_id = $this->make_provider( $owner_id );
		$staff_id    = self::factory()->user->create();
		$this->index_phone( $staff_id, '09121234567' );

		$service = new StaffService();
		$service->add( $business_id, '09121234567', $owner_id );
		$service->remove( $business_id, $staff_id );
		$re_add = $service->add( $business_id, '09121234567', $owner_id );

		$this->assertIsArray( $re_add );
		$this->assertTrue( $service->is_active_staff( $business_id, $staff_id ) );
	}
}
