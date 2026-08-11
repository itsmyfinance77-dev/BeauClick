<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Rest\DashboardController;
use WP_UnitTestCase;

final class DashboardControllerTest extends WP_UnitTestCase {

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	/**
	 * stats() has no id parameter at all — it only ever reads
	 * get_current_user_id() — so the real risk isn't "can user A pass user
	 * B's id", it's "does switching the logged-in user actually change
	 * whose numbers come back." This locks that in.
	 */
	public function test_stats_are_scoped_to_the_current_provider_only(): void {
		$provider_a  = self::factory()->user->create();
		$provider_b  = self::factory()->user->create();
		$customer_id = self::factory()->user->create();

		$slot_a = $this->make_open_slot( $provider_a );
		( new BookingService() )->create_booking( $customer_id, $provider_a, $slot_a );

		wp_set_current_user( $provider_b );
		$response = ( new DashboardController() )->stats( new \WP_REST_Request( 'GET', '/beauclick/v1/booking/my/stats' ) );
		$data     = $response->get_data()['data'];

		$this->assertSame( 0, $data['newClients'], "Provider B must not see provider A's bookings in their own dashboard stats." );
		$this->assertCount( 0, $data['recentBookings'] );
	}

	public function test_stats_route_requires_login(): void {
		wp_set_current_user( 0 );
		$controller = new DashboardController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}
}
