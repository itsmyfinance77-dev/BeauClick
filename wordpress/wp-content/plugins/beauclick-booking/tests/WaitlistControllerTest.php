<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Rest\WaitlistController;
use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

final class WaitlistControllerTest extends WP_UnitTestCase {

	private function make_provider(): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
	}

	// 4. unauthorized access -- a customer cannot cancel another customer's entry.
	public function test_a_customer_cannot_cancel_another_customers_waitlist_entry(): void {
		$provider_id = $this->make_provider();
		$owner_id    = self::factory()->user->create();
		$attacker_id = self::factory()->user->create();
		$entry       = ( new WaitlistService() )->create( $owner_id, $provider_id, null, null, null, null );

		wp_set_current_user( $attacker_id );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/waitlist/{$entry['id']}/cancel" );
		$request->set_param( 'id', $entry['id'] );

		$result = ( new WaitlistController() )->can_cancel( $request );

		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_a_customer_can_cancel_their_own_waitlist_entry_via_the_controller(): void {
		$provider_id = $this->make_provider();
		$owner_id    = self::factory()->user->create();
		$entry       = ( new WaitlistService() )->create( $owner_id, $provider_id, null, null, null, null );

		wp_set_current_user( $owner_id );
		$request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/waitlist/{$entry['id']}/cancel" );
		$request->set_param( 'id', $entry['id'] );

		$this->assertTrue( ( new WaitlistController() )->can_cancel( $request ) );
	}

	public function test_mine_returns_only_the_current_users_own_entries(): void {
		$provider_id = $this->make_provider();
		$user_a      = self::factory()->user->create();
		$user_b      = self::factory()->user->create();
		$service     = new WaitlistService();
		$service->create( $user_a, $provider_id, null, null, null, null );
		$service->create( $user_b, $provider_id, null, null, null, null );

		wp_set_current_user( $user_a );
		$response = ( new WaitlistController() )->mine();
		$data     = $response->get_data()['data'];

		$this->assertCount( 1, $data );
		$this->assertSame( $user_a, $data[0]['customerId'] );
	}

	// A professional/business only ever sees their OWN provider's waitlist.
	public function test_provider_list_returns_only_the_current_professionals_own_provider_entries(): void {
		$owner_id    = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$other_provider_id = $this->make_provider();

		$service = new WaitlistService();
		$service->create( self::factory()->user->create(), $provider_id, null, null, null, null );
		$service->create( self::factory()->user->create(), $other_provider_id, null, null, null, null );

		wp_set_current_user( $owner_id );
		$response = ( new WaitlistController() )->provider_list();
		$data     = $response->get_data()['data'];

		$this->assertCount( 1, $data );
		$this->assertSame( $provider_id, $data[0]['providerId'] );
	}

	public function test_provider_list_is_empty_for_a_user_with_no_provider_profile(): void {
		wp_set_current_user( self::factory()->user->create() );

		$response = ( new WaitlistController() )->provider_list();

		$this->assertSame( [], $response->get_data()['data'] );
	}

	public function test_create_via_controller_rejects_an_invalid_provider(): void {
		wp_set_current_user( self::factory()->user->create() );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/waitlist' );
		$request->set_param( 'provider_id', 999999 );

		$response = ( new WaitlistController() )->create( $request );

		$this->assertSame( 422, $response->get_status() );
	}
}
