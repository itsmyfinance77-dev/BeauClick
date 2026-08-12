<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Otp;

use BeauClick\Auth\Sms\SmsProviderFactory;

/**
 * The one place an OTP code is generated, hashed, rate-limited, and
 * verified. Never stores a plaintext code (hash_hmac('sha256', $code,
 * wp_salt('auth')) -- reuses WordPress's own auth salt rather than
 * inventing new key material, the same "no unnecessary cryptographic
 * infrastructure" instruction this step was given). Rate limiting is
 * transient-backed, mirroring beauclick-ai\AssistantService's and
 * beauclick-chat\ConversationService's own existing 15/min and 20/min
 * transient counters -- no new infrastructure, same established pattern.
 */
final class OtpService {

	/** @return array{ok: bool, errorCode: ?string} errorCode is one of: 'rate_limited', 'cooldown', 'send_failed'. Never reveals whether the phone has an existing account -- request_otp() never looks that up. */
	public function request_otp( string $phone_canonical, string $purpose, ?int $requester_user_id, string $client_ip ): array {
		$cooldown_key = "bc_otp_cooldown_{$phone_canonical}";
		if ( get_transient( $cooldown_key ) ) {
			return [ 'ok' => false, 'errorCode' => 'cooldown' ];
		}

		$phone_count_key = 'bc_otp_count_phone_' . md5( $phone_canonical );
		$phone_count      = (int) get_transient( $phone_count_key );
		if ( $phone_count >= OtpConfig::MAX_REQUESTS_PER_PHONE ) {
			return [ 'ok' => false, 'errorCode' => 'rate_limited' ];
		}

		$ip_count_key = 'bc_otp_count_ip_' . md5( $client_ip );
		$ip_count      = (int) get_transient( $ip_count_key );
		if ( $ip_count >= OtpConfig::MAX_REQUESTS_PER_IP ) {
			return [ 'ok' => false, 'errorCode' => 'rate_limited' ];
		}

		$code = (string) random_int( 10 ** ( OtpConfig::CODE_LENGTH - 1 ), ( 10 ** OtpConfig::CODE_LENGTH ) - 1 );

		global $wpdb;
		$now = current_time( 'mysql' );
		$wpdb->insert(
			$wpdb->prefix . 'bc_otp_requests',
			[
				'phone_canonical'    => $phone_canonical,
				'purpose'            => $purpose,
				'code_hash'          => self::hash_code( $code ),
				'attempts'           => 0,
				'max_attempts'       => OtpConfig::MAX_VERIFY_ATTEMPTS,
				'expires_at'         => gmdate( 'Y-m-d H:i:s', strtotime( $now ) + OtpConfig::EXPIRY_SECONDS ),
				'requester_user_id'  => $requester_user_id,
				'created_at'         => $now,
			],
			[ '%s', '%s', '%s', '%d', '%d', '%s', '%d', '%s' ]
		);

		$message = sprintf( 'کد تأیید BeauClick: %s', self::to_persian_digits( $code ) );
		$result  = SmsProviderFactory::create()->send( $phone_canonical, $message );

		if ( ! $result->success ) {
			return [ 'ok' => false, 'errorCode' => 'send_failed' ];
		}

		/**
		 * Fired after a code is generated and successfully handed to the SMS
		 * provider -- never containing the code itself in any stored/logged
		 * data path (only this in-memory action argument), and with zero
		 * subscribers anywhere in production application code. This is the
		 * one place the test suite can observe a real generated code without
		 * this class ever exposing a raw-code return value or a test-only
		 * code path -- same hook-based, source-fires/consumer-subscribes
		 * convention already used throughout this codebase (e.g.
		 * beauclick/booking/completed).
		 */
		do_action( 'beauclick/auth/otp_generated', $phone_canonical, $code, $purpose );

		set_transient( $cooldown_key, 1, OtpConfig::RESEND_COOLDOWN_SECONDS );
		set_transient( $phone_count_key, $phone_count + 1, OtpConfig::REQUEST_WINDOW_SECONDS );
		set_transient( $ip_count_key, $ip_count + 1, OtpConfig::REQUEST_WINDOW_SECONDS );

		return [ 'ok' => true, 'errorCode' => null ];
	}

	/** @return array{ok: bool, errorCode: ?string} errorCode is one of: 'expired', 'invalid_code', 'too_many_attempts'. */
	public function verify_otp( string $phone_canonical, string $code, string $purpose, ?int $requester_user_id ): array {
		global $wpdb;
		$table = $wpdb->prefix . 'bc_otp_requests';

		$where       = 'phone_canonical = %s AND purpose = %s AND consumed_at IS NULL AND expires_at > %s';
		$params      = [ $phone_canonical, $purpose, current_time( 'mysql' ) ];
		if ( OtpConfig::PURPOSE_CHANGE_PHONE === $purpose ) {
			$where   .= ' AND requester_user_id = %d';
			$params[] = $requester_user_id;
		}

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE {$where} ORDER BY created_at DESC LIMIT 1", $params ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		// No active, unexpired code for this phone/purpose. Deliberately the
		// same error as an expired one -- never lets a caller distinguish
		// "no code was ever requested" from "the code you have is stale",
		// which would otherwise leak whether an OTP flow was ever started
		// for this number.
		if ( ! $row ) {
			return [ 'ok' => false, 'errorCode' => 'expired' ];
		}

		if ( (int) $row['attempts'] >= (int) $row['max_attempts'] ) {
			return [ 'ok' => false, 'errorCode' => 'too_many_attempts' ];
		}

		if ( ! hash_equals( $row['code_hash'], self::hash_code( $code ) ) ) {
			$wpdb->update( $table, [ 'attempts' => (int) $row['attempts'] + 1 ], [ 'id' => (int) $row['id'] ] );
			return [ 'ok' => false, 'errorCode' => 'invalid_code' ];
		}

		// Consumed immediately -- a second verify_otp() call with the same
		// code, even the correct one, now falls into the "no active code"
		// branch above rather than succeeding twice (replay prevention).
		$wpdb->update( $table, [ 'consumed_at' => current_time( 'mysql' ) ], [ 'id' => (int) $row['id'] ] );

		return [ 'ok' => true, 'errorCode' => null ];
	}

	private static function hash_code( string $code ): string {
		return hash_hmac( 'sha256', $code, wp_salt( 'auth' ) );
	}

	private static function to_persian_digits( string $ascii ): string {
		return strtr( $ascii, [ '0' => '۰', '1' => '۱', '2' => '۲', '3' => '۳', '4' => '۴', '5' => '۵', '6' => '۶', '7' => '۷', '8' => '۸', '9' => '۹' ] );
	}
}
