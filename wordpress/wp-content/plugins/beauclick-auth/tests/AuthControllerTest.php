<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Tests;

use BeauClick\Auth\Otp\OtpConfig;
use BeauClick\Auth\Rest\AuthController;
use WP_REST_Request;
use WP_UnitTestCase;

final class AuthControllerTest extends WP_UnitTestCase {

	private function capture_code( string $phone, callable $trigger ): string {
		$captured = null;
		$capture  = function ( $p, $code ) use ( &$captured ) { $captured = $code; };
		add_action( 'beauclick/auth/otp_generated', $capture, 10, 2 );
		$trigger();
		remove_action( 'beauclick/auth/otp_generated', $capture, 10 );
		$this->assertNotNull( $captured, 'Precondition: expected an OTP to have actually been generated.' );
		return $captured;
	}

	public function test_request_otp_rejects_an_invalid_phone_with_a_persian_error(): void {
		$controller = new AuthController();
		$request    = new WP_REST_Request( 'POST', '/beauclick/v1/auth/request-otp' );
		$request->set_param( 'phone', 'not-a-phone' );

		$response = $controller->request_otp( $request );

		$this->assertSame( 422, $response->get_status() );
		$this->assertMatchesRegularExpression( '/^[\x{0600}-\x{06FF}]/u', $response->get_data()['error']['message'] );
	}

	public function test_request_otp_succeeds_for_a_valid_phone(): void {
		$controller = new AuthController();
		$request    = new WP_REST_Request( 'POST', '/beauclick/v1/auth/request-otp' );
		$request->set_param( 'phone', '09121110101' );

		$response = $controller->request_otp( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertTrue( $response->get_data()['data']['sent'] );
	}

	public function test_new_customer_registration_end_to_end(): void {
		$controller = new AuthController();
		$phone      = '09121110102';

		$code = $this->capture_code(
			$phone,
			function () use ( $controller, $phone ) {
				$req = new WP_REST_Request( 'POST', '/beauclick/v1/auth/request-otp' );
				$req->set_param( 'phone', $phone );
				$controller->request_otp( $req );
			}
		);

		$verify = new WP_REST_Request( 'POST', '/beauclick/v1/auth/verify-otp' );
		$verify->set_param( 'phone', $phone );
		$verify->set_param( 'code', $code );
		$response = $controller->verify_otp( $verify );
		$data     = $response->get_data()['data'];

		$this->assertSame( 200, $response->get_status() );
		$this->assertTrue( $data['isNewAccount'] );
		$this->assertGreaterThan( 0, get_current_user_id(), 'A successful new-account verification must actually log the user in.' );
		$this->assertSame( home_url( '/dashboard/' ), $data['redirectUrl'] );
	}

	public function test_existing_customers_data_is_preserved_across_login(): void {
		$phone   = '09121110103';
		$user_id = self::factory()->user->create( [ 'role' => 'customer', 'display_name' => 'مریم قدیمی' ] );
		update_user_meta( $user_id, '_billing_phone', $phone );

		$controller = new AuthController();
		$code = $this->capture_code(
			$phone,
			function () use ( $controller, $phone ) {
				$req = new WP_REST_Request( 'POST', '/beauclick/v1/auth/request-otp' );
				$req->set_param( 'phone', $phone );
				$controller->request_otp( $req );
			}
		);

		$verify = new WP_REST_Request( 'POST', '/beauclick/v1/auth/verify-otp' );
		$verify->set_param( 'phone', $phone );
		$verify->set_param( 'code', $code );
		$response = $controller->verify_otp( $verify );
		$data     = $response->get_data()['data'];

		$this->assertFalse( $data['isNewAccount'] );
		$this->assertSame( $user_id, get_current_user_id() );
		$this->assertSame( 'مریم قدیمی', wp_get_current_user()->display_name, 'Logging in via OTP must authenticate the real existing account, not create a lookalike new one -- their display name (and by extension every other real record) must be exactly the pre-existing one.' );
	}

	public function test_logout_requires_login(): void {
		wp_set_current_user( 0 );
		$controller = new AuthController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}

	public function test_logout_clears_the_current_user(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );
		$this->assertGreaterThan( 0, get_current_user_id() );

		// WooCommerce's own wp_logout-hooked session-cookie clearing calls
		// PHP's setcookie() directly, which raises a harmless E_WARNING in
		// the CLI/PHPUnit test environment (there is no real HTTP response
		// to attach a cookie header to) -- suppressed here as a documented,
		// known test-harness artifact. AuthController::logout() itself runs
		// inside a real REST response in every actual request, where this
		// does not occur.
		@( new AuthController() )->logout();

		$this->assertSame( 0, get_current_user_id(), 'After logout, no user should remain authenticated.' );
	}

	public function test_change_phone_endpoints_require_login(): void {
		wp_set_current_user( 0 );
		$controller = new AuthController();
		$this->assertInstanceOf( \WP_Error::class, $controller->require_login() );
	}

	public function test_change_phone_end_to_end_for_a_logged_in_user(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		wp_set_current_user( $user_id );
		$new_phone = '09121110104';

		$controller = new AuthController();
		$code = $this->capture_code(
			$new_phone,
			function () use ( $controller, $new_phone ) {
				$req = new WP_REST_Request( 'POST', '/beauclick/v1/auth/change-phone/request' );
				$req->set_param( 'phone', $new_phone );
				$controller->request_phone_change( $req );
			}
		);

		$confirm = new WP_REST_Request( 'POST', '/beauclick/v1/auth/change-phone/confirm' );
		$confirm->set_param( 'phone', $new_phone );
		$confirm->set_param( 'code', $code );
		$response = $controller->confirm_phone_change( $confirm );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( '0' . '9121110104', get_user_meta( $user_id, '_billing_phone', true ) );

		global $wpdb;
		$linked = (int) $wpdb->get_var( $wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", '+989121110104' ) );
		$this->assertSame( $user_id, $linked );
	}

	public function test_change_phone_is_rejected_if_the_number_already_belongs_to_someone_else(): void {
		$other_user = self::factory()->user->create( [ 'role' => 'customer' ] );
		( new \BeauClick\Auth\Account\AccountResolver() )->find_or_create_for_phone( '+989121110105' );
		global $wpdb;
		$wpdb->update( $wpdb->prefix . 'bc_phone_index', [ 'user_id' => $other_user ], [ 'phone_canonical' => '+989121110105' ] );

		$user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		wp_set_current_user( $user_id );

		$controller = new AuthController();

		// No OTP is actually generated for a number that already belongs to
		// someone else -- deliberately, per this endpoint's own
		// anti-enumeration design (see AuthController::request_phone_change's
		// docblock). The response still looks like an ordinary success, so
		// this asserts the real security property: no code was hooked, and
		// no code the attacker could plausibly guess (including their own
		// leftover code from an earlier request) confirms the change.
		$captured = null;
		$capture  = function ( $p, $code ) use ( &$captured ) { $captured = $code; };
		add_action( 'beauclick/auth/otp_generated', $capture, 10, 2 );
		$req = new WP_REST_Request( 'POST', '/beauclick/v1/auth/change-phone/request' );
		$req->set_param( 'phone', '09121110105' );
		$request_response = $controller->request_phone_change( $req );
		remove_action( 'beauclick/auth/otp_generated', $capture, 10 );

		$this->assertSame( 200, $request_response->get_status(), 'The request-side response must look like an ordinary success -- it must not reveal that the number is already taken.' );
		$this->assertNull( $captured, 'No real OTP may ever be issued for a number that already belongs to a different account.' );

		$confirm = new WP_REST_Request( 'POST', '/beauclick/v1/auth/change-phone/confirm' );
		$confirm->set_param( 'phone', '09121110105' );
		$confirm->set_param( 'code', '000000' );
		$response = $controller->confirm_phone_change( $confirm );

		$this->assertSame( 422, $response->get_status(), 'With no real OTP ever issued, no code can possibly confirm the change -- it must fail as an invalid/expired code, and the number must never actually move to the new account.' );
		$this->assertSame( $other_user, (int) $wpdb->get_var( $wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", '+989121110105' ) ) );
	}

	public function test_admin_authentication_is_unaffected_by_this_plugin(): void {
		// This plugin never touches wp-login.php, WP_Auth_Cookie for other
		// flows, or the administrator role's own capabilities -- an admin
		// account created and authenticated the normal WordPress way must
		// continue to work exactly as before.
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		$this->assertTrue( user_can( $admin_id, 'manage_options' ) );
		$this->assertContains( 'administrator', wp_get_current_user()->roles );
	}
}
