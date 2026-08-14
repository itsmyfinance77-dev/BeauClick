<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Rest\CrmController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

final class CrmControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_booking( int $provider_id, int $customer_id, string $status = 'completed' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 0,
				'slot_start'  => current_time( 'mysql' ),
				'slot_end'    => current_time( 'mysql' ),
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return (int) $wpdb->insert_id;
	}

	public function test_list_customers_requires_login(): void {
		wp_set_current_user( 0 );
		$controller = new CrmController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}

	public function test_list_customers_is_empty_for_a_user_with_no_provider_profile(): void {
		$user = self::factory()->user->create();
		wp_set_current_user( $user );

		$response = ( new CrmController() )->list_customers( new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers' ) );
		$body     = $response->get_data();

		$this->assertSame( [], $body['data'] );
		$this->assertSame( 0, $body['meta']->pagination['total'] );
	}

	public function test_professional_a_cannot_reach_professional_bs_customer_detail(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$provider_b  = $this->make_provider( $owner_b );
		$customer_of_b = self::factory()->user->create();
		$this->make_booking( $provider_b, $customer_of_b );

		wp_set_current_user( $owner_a );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers/' . $customer_of_b );
		$request->set_param( 'id', $customer_of_b );
		$response = ( new CrmController() )->customer_detail( $request );

		$this->assertSame( 404, $response->get_status(), 'A stranger provider must never see another provider\'s customer, and the response must not distinguish "not mine" from "does not exist".' );
		$this->assertNotNull( $response->get_data()['error'] );
		$this->assertMatchesRegularExpression( '/^[\x{0600}-\x{06FF}]/u', $response->get_data()['error']['message'], 'The error message must be Persian.' );
	}

	public function test_the_owning_professional_can_reach_their_own_customer_detail(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		wp_set_current_user( $owner );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers/' . $customer_id );
		$request->set_param( 'id', $customer_id );
		$response = ( new CrmController() )->customer_detail( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( $customer_id, $response->get_data()['data']['customer']['id'] );
	}

	public function test_a_customer_account_itself_has_no_provider_and_cannot_reach_crm(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		// The customer tries to view "their own" CRM record directly.
		wp_set_current_user( $customer_id );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers/' . $customer_id );
		$request->set_param( 'id', $customer_id );
		$response = ( new CrmController() )->customer_detail( $request );

		$this->assertSame( 404, $response->get_status(), 'A plain customer account (no provider profile) must never see CRM data, including their own — CRM is a professional-facing surface.' );
	}

	public function test_adding_a_note_for_an_unowned_customer_is_rejected(): void {
		$owner_a       = self::factory()->user->create();
		$owner_b       = self::factory()->user->create();
		$provider_a    = $this->make_provider( $owner_a );
		$provider_b    = $this->make_provider( $owner_b );
		$customer_of_b = self::factory()->user->create();
		$this->make_booking( $provider_b, $customer_of_b );

		wp_set_current_user( $owner_a );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/crm/customers/' . $customer_of_b . '/notes' );
		$request->set_param( 'id', $customer_of_b );
		$request->set_param( 'note', 'یادداشت غیرمجاز' );
		$response = ( new CrmController() )->add_note( $request );

		$this->assertSame( 404, $response->get_status() );
	}

	public function test_adding_an_empty_note_returns_a_persian_validation_error(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		wp_set_current_user( $owner );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/crm/customers/' . $customer_id . '/notes' );
		$request->set_param( 'id', $customer_id );
		$request->set_param( 'note', '' );
		$response = ( new CrmController() )->add_note( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertMatchesRegularExpression( '/^[\x{0600}-\x{06FF}]/u', $response->get_data()['error']['message'] );
	}

	public function test_adding_a_valid_note_returns_it_with_author_name_and_is_then_listed_in_detail(): void {
		$owner       = self::factory()->user->create( [ 'display_name' => 'سارا احمدی' ] );
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		wp_set_current_user( $owner );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/booking/crm/customers/' . $customer_id . '/notes' );
		$request->set_param( 'id', $customer_id );
		$request->set_param( 'note', 'یادآوری: آلرژی به مواد خاص رنگ مو داره.' );
		$response = ( new CrmController() )->add_note( $request );

		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( 'سارا احمدی', $response->get_data()['data']['authorName'] );

		$detail_request = new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers/' . $customer_id );
		$detail_request->set_param( 'id', $customer_id );
		$detail = ( new CrmController() )->customer_detail( $detail_request )->get_data()['data'];

		$this->assertCount( 1, $detail['notes'] );
	}

	public function test_pagination_params_are_respected(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		for ( $i = 0; $i < 3; $i++ ) {
			$this->make_booking( $provider_id, self::factory()->user->create() );
		}

		wp_set_current_user( $owner );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers' );
		$request->set_param( 'per_page', 2 );
		$request->set_param( 'page', 1 );
		$response = ( new CrmController() )->list_customers( $request );
		$body     = $response->get_data();

		$this->assertCount( 2, $body['data'] );
		$this->assertSame( 3, $body['meta']->pagination['total'] );
		$this->assertSame( 2, $body['meta']->pagination['pages'] );
	}

	// --- V2.2 Step 16 -- note edit/delete REST layer ----------------------

	public function test_update_note_rest_endpoint_works_for_the_author(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		wp_set_current_user( $owner );
		$controller  = new CrmController();
		$add_request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/crm/customers/{$customer_id}/notes" );
		$add_request->set_param( 'id', $customer_id );
		$add_request->set_param( 'note', 'یادداشت اول' );
		$note_id = $controller->add_note( $add_request )->get_data()['data']['id'];

		$update_request = new WP_REST_Request( 'PATCH', "/beauclick/v1/booking/crm/customers/{$customer_id}/notes/{$note_id}" );
		$update_request->set_param( 'id', $customer_id );
		$update_request->set_param( 'note_id', $note_id );
		$update_request->set_param( 'note', 'یادداشت ویرایش‌شده' );

		$response = $controller->update_note( $update_request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( 'یادداشت ویرایش‌شده', $response->get_data()['data']['note'] );
	}

	public function test_delete_note_rest_endpoint_returns_404_for_a_note_that_is_not_yours(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_a, $customer_id );

		wp_set_current_user( $owner_a );
		$controller  = new CrmController();
		$add_request = new WP_REST_Request( 'POST', "/beauclick/v1/booking/crm/customers/{$customer_id}/notes" );
		$add_request->set_param( 'id', $customer_id );
		$add_request->set_param( 'note', 'یادداشت واقعی' );
		$note_id = $controller->add_note( $add_request )->get_data()['data']['id'];

		wp_set_current_user( $owner_b );
		$delete_request = new WP_REST_Request( 'DELETE', "/beauclick/v1/booking/crm/customers/{$customer_id}/notes/{$note_id}" );
		$delete_request->set_param( 'id', $customer_id );
		$delete_request->set_param( 'note_id', $note_id );

		$response = $controller->delete_note( $delete_request );

		$this->assertSame( 404, $response->get_status() );
	}

	// --- V2.2 Step 16 -- staff access to CRM -------------------------------

	public function test_an_authorized_staff_member_can_see_the_businesss_own_customers(): void {
		if ( ! class_exists( '\BeauClick\Marketplace\Staff\StaffService' ) ) {
			$this->markTestSkipped( 'beauclick-marketplace Staff module not active in this test run.' );
		}
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		$staff_id = self::factory()->user->create();
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_business_staff',
			[ 'business_id' => $provider_id, 'user_id' => $staff_id, 'role' => 'staff', 'status' => 'active', 'added_by' => $owner, 'created_at' => current_time( 'mysql' ) ]
		);

		wp_set_current_user( $staff_id );
		$response = ( new CrmController() )->list_customers( new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers' ) );

		$this->assertCount( 1, $response->get_data()['data'], 'An authorized staff member must see the business\'s real customers, not an empty list.' );
	}

	public function test_a_removed_staff_member_loses_crm_access(): void {
		if ( ! class_exists( '\BeauClick\Marketplace\Staff\StaffService' ) ) {
			$this->markTestSkipped( 'beauclick-marketplace Staff module not active in this test run.' );
		}
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id );

		$staff_id = self::factory()->user->create();
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_business_staff',
			[ 'business_id' => $provider_id, 'user_id' => $staff_id, 'role' => 'staff', 'status' => 'removed', 'added_by' => $owner, 'created_at' => current_time( 'mysql' ) ]
		);

		wp_set_current_user( $staff_id );
		$response = ( new CrmController() )->list_customers( new WP_REST_Request( 'GET', '/beauclick/v1/booking/crm/customers' ) );

		$this->assertCount( 0, $response->get_data()['data'], 'A removed ("status=removed") staff row must not grant CRM access.' );
	}
}
