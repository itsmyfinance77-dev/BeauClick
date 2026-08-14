<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Rest\AvailabilityController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

final class AvailabilityControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function far_future(): string {
		return gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 240 * HOUR_IN_SECONDS );
	}

	public function test_the_owning_professional_can_create_and_list_their_own_slot(): void {
		$owner = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$this->make_provider( $owner );
		wp_set_current_user( $owner );

		$start = $this->far_future();
		$end   = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/my/availability' );
		$request->set_param( 'start_at', $start );
		$request->set_param( 'end_at', $end );

		$response = ( new AvailabilityController() )->create_slot( $request );
		$this->assertSame( 201, $response->get_status() );

		$list = ( new AvailabilityController() )->list_own()->get_data()['data'];
		$this->assertCount( 1, $list );
	}

	public function test_a_customer_without_bc_book_service_only_capability_cannot_manage_availability(): void {
		$customer = self::factory()->user->create(); // Plain 'customer' role — has bc_book_service, not bc_manage_own_availability.
		wp_set_current_user( $customer );

		$this->assertInstanceOf( \WP_Error::class, ( new AvailabilityController() )->can_manage_own_availability() );
	}

	public function test_list_own_never_leaks_another_providers_slots(): void {
		$owner_a = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$owner_b = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_a = $this->make_provider( $owner_a );
		$provider_b = $this->make_provider( $owner_b );

		global $wpdb;
		$start = $this->far_future();
		$wpdb->insert( $wpdb->prefix . 'bc_availability_slots', [ 'provider_id' => $provider_b, 'start_at' => $start, 'end_at' => $start, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ] );

		wp_set_current_user( $owner_a );
		$list = ( new AvailabilityController() )->list_own()->get_data()['data'];

		$this->assertCount( 0, $list, 'Provider A must never see provider B\'s availability slots.' );
	}

	public function test_error_codes_map_to_the_correct_http_status_and_are_persian(): void {
		$owner = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$this->make_provider( $owner );
		wp_set_current_user( $owner );

		$past = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - HOUR_IN_SECONDS );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/my/availability' );
		$request->set_param( 'start_at', $past );
		$request->set_param( 'end_at', gmdate( 'Y-m-d H:i:s', strtotime( $past ) + HOUR_IN_SECONDS ) );

		$response = ( new AvailabilityController() )->create_slot( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertSame( 'bc_slot_in_past', $response->get_data()['error']['code'] );
		$this->assertNotEmpty( $response->get_data()['error']['message'] );
	}

	public function test_bulk_generate_rest_endpoint_creates_real_slots(): void {
		$owner = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$this->make_provider( $owner );
		wp_set_current_user( $owner );

		$date_from = gmdate( 'Y-m-d', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS );
		$request   = new WP_REST_Request( 'POST', '/beauclick/v1/booking/my/availability/bulk' );
		$request->set_param( 'weekdays', [ 0, 1, 2, 3, 4, 5, 6 ] );
		$request->set_param( 'time_start', '10:00' );
		$request->set_param( 'time_end', '12:00' );
		$request->set_param( 'slot_minutes', 60 );
		$request->set_param( 'date_from', $date_from );
		$request->set_param( 'date_to', $date_from );

		$response = ( new AvailabilityController() )->bulk_generate( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 2, $response->get_data()['data']['created'] );
	}

	public function test_deleting_someone_elses_slot_is_denied(): void {
		$owner_a = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$owner_b = self::factory()->user->create( [ 'role' => 'bc_professional' ] );
		$provider_b = $this->make_provider( $owner_b );

		global $wpdb;
		$start = $this->far_future();
		$wpdb->insert( $wpdb->prefix . 'bc_availability_slots', [ 'provider_id' => $provider_b, 'start_at' => $start, 'end_at' => $start, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ] );
		$slot_id = $wpdb->insert_id;

		wp_set_current_user( $owner_a );
		$request = new WP_REST_Request( 'DELETE', "/beauclick/v1/booking/my/availability/{$slot_id}" );
		$request->set_param( 'id', $slot_id );

		$response = ( new AvailabilityController() )->delete_slot( $request );

		$this->assertSame( 409, $response->get_status() );
	}
}
