<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Tests;

use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Deletion\DeletionService;
use BeauClick\Privacy\Export\ExportService;
use BeauClick\Privacy\Rest\PrivacyController;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * Authorization at the REST boundary — every route here is self-scoped, so
 * these tests specifically prove a caller can never reach or act on
 * another user's export/deletion request, matching the exact
 * "who is allowed to call which route with which resource" scope
 * VerificationControllerTest already established for Step 8.
 */
final class PrivacyControllerTest extends WP_UnitTestCase {

	public function test_every_route_requires_login(): void {
		wp_set_current_user( 0 );
		$this->assertTrue( is_wp_error( ( new PrivacyController() )->require_login() ) );

		wp_set_current_user( self::factory()->user->create() );
		$this->assertTrue( ( new PrivacyController() )->require_login() );
	}

	public function test_export_download_returns_not_found_for_an_unknown_token(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$request = new WP_REST_Request( 'GET', '/beauclick/v1/privacy/export/download' );
		$request->set_param( 'token', 'this-token-does-not-exist' );

		$response = ( new PrivacyController() )->export_download( $request );
		$this->assertSame( 404, $response->get_status() );
	}

	public function test_export_download_never_serves_another_users_export(): void {
		$owner_id = self::factory()->user->create();
		$attacker_id = self::factory()->user->create();

		$row = ( new ExportService() )->request( $owner_id );

		wp_set_current_user( $attacker_id );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/privacy/export/download' );
		$request->set_param( 'token', $row['export_token'] );

		$response = ( new PrivacyController() )->export_download( $request );
		$this->assertSame( 404, $response->get_status(), 'A token belonging to another user must be indistinguishable from an unknown one -- no account/token enumeration.' );
	}

	/**
	 * The success path (real ZIP bytes via header()+readfile()+exit) is
	 * deliberately not exercised here, same as this codebase's own
	 * VerificationControllerTest never calls download_evidence() for its
	 * 200 case -- header() fails once PHPUnit's own bootstrap has already
	 * sent output, and exit() would kill the test runner. What matters most
	 * (an owner is never wrongly denied) is instead proven at the data
	 * layer: the row this method looks up by token really does belong to
	 * the owner, is 'ready', and has a future expiry -- i.e. every
	 * early-return condition in export_download() correctly stays false.
	 */
	public function test_export_download_lookup_conditions_all_pass_for_the_real_owner(): void {
		$owner_id = self::factory()->user->create();
		$row      = ( new ExportService() )->request( $owner_id );

		global $wpdb;
		$fetched = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE export_token = %s", $row['export_token'] ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		$this->assertNotNull( $fetched );
		$this->assertSame( $owner_id, (int) $fetched['user_id'] );
		$this->assertSame( DataRequestService::STATUS_READY, $fetched['status'] );
		$this->assertNotEmpty( $fetched['export_file'] );
		$this->assertGreaterThan( time(), strtotime( (string) $fetched['expires_at'] ) );
	}

	public function test_deletion_otp_request_fails_gracefully_for_a_user_with_no_verified_phone(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$response = ( new PrivacyController() )->deletion_otp_request();
		$this->assertSame( 422, $response->get_status() );
	}

	public function test_deletion_request_rejects_an_invalid_otp_code(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$this->link_phone( $user_id, '+989120000001' );

		$request = new WP_REST_Request( 'POST', '/beauclick/v1/privacy/deletion/request' );
		$request->set_param( 'code', '000000' );

		$response = ( new PrivacyController() )->deletion_request( $request );
		$this->assertSame( 422, $response->get_status() );
	}

	public function test_deletion_cancel_cannot_be_used_on_another_users_request(): void {
		$owner_id    = self::factory()->user->create();
		$attacker_id = self::factory()->user->create();

		$result = ( new DeletionService() )->request_deletion( $owner_id );

		wp_set_current_user( $attacker_id );
		$request = new WP_REST_Request( 'POST', '/beauclick/v1/privacy/deletion/cancel' );
		$request->set_param( 'requestId', $result['requestId'] );

		$response = ( new PrivacyController() )->deletion_cancel( $request );
		$this->assertSame( 409, $response->get_status() );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_PENDING, $row['status'], 'A different user\'s cancel attempt must never change the real owner\'s request state.' );
	}

	private function link_phone( int $user_id, string $phone ): void {
		global $wpdb;
		$now = current_time( 'mysql' );
		$wpdb->replace(
			$wpdb->prefix . 'bc_phone_index',
			[ 'user_id' => $user_id, 'phone_canonical' => $phone, 'verified_at' => $now, 'created_at' => $now ],
			[ '%d', '%s', '%s', '%s' ]
		);
	}
}
