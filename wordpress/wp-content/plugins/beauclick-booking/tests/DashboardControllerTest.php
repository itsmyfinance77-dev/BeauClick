<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Rest\DashboardController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class DashboardControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_open_slot( int $provider_post_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_post_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	/**
	 * bc_bookings.provider_id is the professional's CPT post id, not their
	 * WP user id (ProviderLookup) — stats() must resolve the logged-in
	 * user's OWN provider post before querying, not compare
	 * get_current_user_id() against provider_id directly. This is the exact
	 * bug a live-verification pass caught: with real (non-matching) post/
	 * user ids, every real professional's dashboard silently showed zeros.
	 */
	public function test_the_owning_professional_sees_their_own_stats(): void {
		$owner_id  = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner_id );
		$customer_id = self::factory()->user->create();

		$slot = $this->make_open_slot( $provider_id );
		( new BookingService() )->create_booking( $customer_id, $provider_id, $slot );

		wp_set_current_user( $owner_id );
		$response = ( new DashboardController() )->stats( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/my/stats' ) );
		$data     = $response->get_data()['data'];

		$this->assertSame( 1, $data['newClients'], "The professional who actually owns the provider post must see their own real booking." );
		$this->assertCount( 1, $data['recentBookings'] );
	}

	public function test_stats_are_scoped_to_the_current_provider_only(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$this->make_provider( $owner_b );
		$customer_id = self::factory()->user->create();

		$slot_a = $this->make_open_slot( $provider_a );
		( new BookingService() )->create_booking( $customer_id, $provider_a, $slot_a );

		wp_set_current_user( $owner_b );
		$response = ( new DashboardController() )->stats( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/my/stats' ) );
		$data     = $response->get_data()['data'];

		$this->assertSame( 0, $data['newClients'], "Provider B must not see provider A's bookings in their own dashboard stats." );
		$this->assertCount( 0, $data['recentBookings'] );
	}

	public function test_a_user_with_no_provider_profile_yet_sees_zeroed_stats_not_an_error(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$response = ( new DashboardController() )->stats( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/my/stats' ) );
		$data     = $response->get_data()['data'];

		$this->assertSame( 0, $data['todaysBookings'] );
		$this->assertSame( [], $data['recentBookings'] );
	}

	public function test_stats_route_requires_login(): void {
		wp_set_current_user( 0 );
		$controller = new DashboardController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}
}
