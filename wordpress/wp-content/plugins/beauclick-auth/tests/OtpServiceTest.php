<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Tests;

use BeauClick\Auth\Otp\OtpConfig;
use BeauClick\Auth\Otp\OtpService;
use WP_UnitTestCase;

final class OtpServiceTest extends WP_UnitTestCase {

	/** Captures the real generated code via the do_action seam OtpService fires -- see that class's own docblock for why this exists instead of a test-only return value. */
	private function request_and_capture_code( string $phone, string $purpose = OtpConfig::PURPOSE_LOGIN_OR_REGISTER, ?int $requester = null ): string {
		$captured = null;
		$capture  = function ( $p, $code ) use ( &$captured ) {
			$captured = $code;
		};
		add_action( 'beauclick/auth/otp_generated', $capture, 10, 2 );
		$result = ( new OtpService() )->request_otp( $phone, $purpose, $requester, '127.0.0.1' );
		remove_action( 'beauclick/auth/otp_generated', $capture, 10 );

		$this->assertTrue( $result['ok'], 'Precondition: the OTP request itself must succeed for this helper to be useful.' );
		$this->assertNotNull( $captured );
		return $captured;
	}

	public function test_a_generated_code_is_the_configured_length_and_numeric(): void {
		$code = $this->request_and_capture_code( '+989120000001' );
		$this->assertSame( OtpConfig::CODE_LENGTH, strlen( $code ) );
		$this->assertMatchesRegularExpression( '/^\d+$/', $code );
	}

	public function test_a_correct_code_verifies_successfully(): void {
		$code   = $this->request_and_capture_code( '+989120000002' );
		$result = ( new OtpService() )->verify_otp( '+989120000002', $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$this->assertTrue( $result['ok'] );
	}

	public function test_a_wrong_code_is_rejected(): void {
		$this->request_and_capture_code( '+989120000003' );
		$result = ( new OtpService() )->verify_otp( '+989120000003', '000000', OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'invalid_code', $result['errorCode'] );
	}

	public function test_verifying_with_no_otp_ever_requested_returns_the_same_error_as_expired(): void {
		$result = ( new OtpService() )->verify_otp( '+989129999999', '123456', OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'expired', $result['errorCode'], 'Must not be distinguishable from a genuinely expired code -- otherwise this endpoint leaks whether an OTP flow was ever started for a given number.' );
	}

	public function test_a_code_cannot_be_replayed_after_successful_verification(): void {
		$code = $this->request_and_capture_code( '+989120000004' );
		$first  = ( new OtpService() )->verify_otp( '+989120000004', $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$second = ( new OtpService() )->verify_otp( '+989120000004', $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );

		$this->assertTrue( $first['ok'] );
		$this->assertFalse( $second['ok'], 'A consumed code must never verify a second time.' );
		$this->assertSame( 'expired', $second['errorCode'] );
	}

	public function test_max_verify_attempts_locks_out_further_tries_even_with_the_correct_code(): void {
		$code = $this->request_and_capture_code( '+989120000005' );
		$service = new OtpService();

		for ( $i = 0; $i < OtpConfig::MAX_VERIFY_ATTEMPTS; $i++ ) {
			$service->verify_otp( '+989120000005', 'wrong0' . $i, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		}

		$result = $service->verify_otp( '+989120000005', $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'too_many_attempts', $result['errorCode'], 'After the configured number of wrong attempts, even the genuinely correct code must be rejected -- a new OTP is required.' );
	}

	public function test_an_expired_code_is_rejected(): void {
		global $wpdb;
		$code = $this->request_and_capture_code( '+989120000006' );
		// Force the just-issued row into the past rather than waiting real time out.
		$wpdb->update( $wpdb->prefix . 'bc_otp_requests', [ 'expires_at' => gmdate( 'Y-m-d H:i:s', time() - 10 ) ], [ 'phone_canonical' => '+989120000006' ] );

		$result = ( new OtpService() )->verify_otp( '+989120000006', $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'expired', $result['errorCode'] );
	}

	public function test_resend_cooldown_blocks_an_immediate_second_request(): void {
		$service = new OtpService();
		$first  = $service->request_otp( '+989120000007', OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '127.0.0.1' );
		$second = $service->request_otp( '+989120000007', OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '127.0.0.1' );

		$this->assertTrue( $first['ok'] );
		$this->assertFalse( $second['ok'] );
		$this->assertSame( 'cooldown', $second['errorCode'] );
	}

	public function test_per_phone_request_rate_limit_is_enforced(): void {
		$service = new OtpService();
		$phone   = '+989120000008';

		for ( $i = 0; $i < OtpConfig::MAX_REQUESTS_PER_PHONE; $i++ ) {
			// Bypass the cooldown transient directly between iterations so this test isolates the *count* limit, not the cooldown.
			delete_transient( "bc_otp_cooldown_{$phone}" );
			$service->request_otp( $phone, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '10.0.0.1' );
		}
		delete_transient( "bc_otp_cooldown_{$phone}" );
		$result = $service->request_otp( $phone, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '10.0.0.1' );

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'rate_limited', $result['errorCode'] );
	}

	public function test_per_ip_request_rate_limit_is_enforced_across_different_phones(): void {
		$service = new OtpService();

		for ( $i = 0; $i < OtpConfig::MAX_REQUESTS_PER_IP; $i++ ) {
			$service->request_otp( '+98912000' . str_pad( (string) ( 9000 + $i ), 4, '0', STR_PAD_LEFT ), OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '10.0.0.2' );
		}
		$result = $service->request_otp( '+989120009999', OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, '10.0.0.2' );

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'rate_limited', $result['errorCode'], 'A single IP flooding many different phone numbers must also be blocked, not only repeated requests for one number.' );
	}

	public function test_the_stored_code_hash_is_never_the_plaintext_code(): void {
		global $wpdb;
		$code = $this->request_and_capture_code( '+989120000010' );
		$row  = $wpdb->get_row( $wpdb->prepare( "SELECT code_hash FROM {$wpdb->prefix}bc_otp_requests WHERE phone_canonical = %s ORDER BY id DESC LIMIT 1", '+989120000010' ), ARRAY_A );

		$this->assertNotSame( $code, $row['code_hash'] );
		$this->assertSame( 64, strlen( $row['code_hash'] ), 'Expected a hex-encoded SHA-256 HMAC digest.' );
	}

	public function test_change_phone_purpose_requires_matching_requester(): void {
		$code = $this->request_and_capture_code( '+989120000011', OtpConfig::PURPOSE_CHANGE_PHONE, 42 );

		$wrong_requester = ( new OtpService() )->verify_otp( '+989120000011', $code, OtpConfig::PURPOSE_CHANGE_PHONE, 99 );
		$right_requester = ( new OtpService() )->verify_otp( '+989120000011', $code, OtpConfig::PURPOSE_CHANGE_PHONE, 42 );

		$this->assertFalse( $wrong_requester['ok'], 'A change-phone code issued for one logged-in user must not verify under a different user id.' );
		$this->assertTrue( $right_requester['ok'] );
	}
}
