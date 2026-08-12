<?php
declare( strict_types=1 );

namespace BeauClick\Auth\Rest;

use BeauClick\Auth\Account\AccountResolver;
use BeauClick\Auth\Otp\OtpConfig;
use BeauClick\Auth\Otp\OtpService;
use BeauClick\Auth\Phone\PhoneNormalizer;
use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

/**
 * Phone/OTP sign-in and registration -- the customer/professional/business
 * authentication path this step exists to build. WordPress's own
 * wp-login.php remains the administrator path, completely untouched by
 * this controller (see beauclick-auth's own plugin docblock).
 *
 * request-otp/verify-otp are permission_callback __return_true
 * deliberately -- nobody is logged in yet at that point, by definition.
 * change-phone/* require an existing session, since only an already-
 * authenticated user may request to change their own number.
 */
final class AuthController extends RestController {

	public function register_routes(): void {
		$this->route( '/auth/request-otp', [ 'methods' => 'POST', 'callback' => [ $this, 'request_otp' ], 'permission_callback' => '__return_true' ] );
		$this->route( '/auth/verify-otp', [ 'methods' => 'POST', 'callback' => [ $this, 'verify_otp' ], 'permission_callback' => '__return_true' ] );
		$this->route( '/auth/logout', [ 'methods' => 'POST', 'callback' => [ $this, 'logout' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/auth/change-phone/request', [ 'methods' => 'POST', 'callback' => [ $this, 'request_phone_change' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/auth/change-phone/confirm', [ 'methods' => 'POST', 'callback' => [ $this, 'confirm_phone_change' ], 'permission_callback' => [ $this, 'require_login' ] ] );
	}

	public function request_otp( WP_REST_Request $request ) {
		$phone = $this->normalize_or_error( (string) $request->get_param( 'phone' ) );
		if ( is_wp_error( $phone ) ) {
			return Response::error( 'bc_invalid_phone', __( 'شماره موبایل واردشده معتبر نیست.', 'beauclick-auth' ), 422 );
		}

		$result = ( new OtpService() )->request_otp( $phone, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null, $this->client_ip() );

		if ( ! $result['ok'] ) {
			return $this->otp_request_error_response( $result['errorCode'] );
		}

		return Response::ok( [ 'sent' => true, 'expiresInSeconds' => OtpConfig::EXPIRY_SECONDS ] );
	}

	public function verify_otp( WP_REST_Request $request ) {
		$phone = $this->normalize_or_error( (string) $request->get_param( 'phone' ) );
		$code  = trim( (string) $request->get_param( 'code' ) );
		if ( is_wp_error( $phone ) ) {
			return Response::error( 'bc_invalid_phone', __( 'شماره موبایل واردشده معتبر نیست.', 'beauclick-auth' ), 422 );
		}
		if ( '' === $code ) {
			return Response::error( 'bc_invalid_input', __( 'لطفاً کد تأیید را وارد کنید.', 'beauclick-auth' ), 422 );
		}

		$result = ( new OtpService() )->verify_otp( $phone, $code, OtpConfig::PURPOSE_LOGIN_OR_REGISTER, null );
		if ( ! $result['ok'] ) {
			return $this->otp_verify_error_response( $result['errorCode'] );
		}

		$account = ( new AccountResolver() )->find_or_create_for_phone( $phone );

		wp_set_current_user( $account['userId'] );
		wp_set_auth_cookie( $account['userId'], true );
		do_action( 'wp_login', get_userdata( $account['userId'] )->user_login, get_userdata( $account['userId'] ) );

		return Response::ok(
			[
				'isNewAccount' => $account['isNew'],
				'redirectUrl'  => home_url( '/dashboard/' ),
			]
		);
	}

	public function logout(): \WP_REST_Response {
		wp_logout();
		return Response::ok( [ 'loggedOut' => true ] );
	}

	public function request_phone_change( WP_REST_Request $request ) {
		$phone = $this->normalize_or_error( (string) $request->get_param( 'phone' ) );
		if ( is_wp_error( $phone ) ) {
			return Response::error( 'bc_invalid_phone', __( 'شماره موبایل واردشده معتبر نیست.', 'beauclick-auth' ), 422 );
		}

		global $wpdb;
		$taken = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", $phone ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $taken && $taken !== get_current_user_id() ) {
			// Deliberately the same shape as a normal successful "sent"
			// response -- confirming "that number is already someone else's"
			// here would be an account-enumeration leak on a currently-
			// authenticated endpoint, the one place it would be easiest to
			// script automatically against.
			return Response::ok( [ 'sent' => true, 'expiresInSeconds' => OtpConfig::EXPIRY_SECONDS ] );
		}

		$result = ( new OtpService() )->request_otp( $phone, OtpConfig::PURPOSE_CHANGE_PHONE, get_current_user_id(), $this->client_ip() );
		if ( ! $result['ok'] ) {
			return $this->otp_request_error_response( $result['errorCode'] );
		}

		return Response::ok( [ 'sent' => true, 'expiresInSeconds' => OtpConfig::EXPIRY_SECONDS ] );
	}

	public function confirm_phone_change( WP_REST_Request $request ) {
		$phone = $this->normalize_or_error( (string) $request->get_param( 'phone' ) );
		$code  = trim( (string) $request->get_param( 'code' ) );
		if ( is_wp_error( $phone ) ) {
			return Response::error( 'bc_invalid_phone', __( 'شماره موبایل واردشده معتبر نیست.', 'beauclick-auth' ), 422 );
		}

		$user_id = get_current_user_id();
		$result  = ( new OtpService() )->verify_otp( $phone, $code, OtpConfig::PURPOSE_CHANGE_PHONE, $user_id );
		if ( ! $result['ok'] ) {
			return $this->otp_verify_error_response( $result['errorCode'] );
		}

		global $wpdb;
		$taken = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT user_id FROM {$wpdb->prefix}bc_phone_index WHERE phone_canonical = %s", $phone ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		if ( $taken && $taken !== $user_id ) {
			return Response::error( 'bc_phone_taken', __( 'این شماره قابل استفاده نیست.', 'beauclick-auth' ), 409 );
		}

		$now = current_time( 'mysql' );
		$wpdb->replace(
			$wpdb->prefix . 'bc_phone_index',
			[ 'user_id' => $user_id, 'phone_canonical' => $phone, 'verified_at' => $now, 'created_at' => $now ],
			[ '%d', '%s', '%s', '%s' ]
		);
		update_user_meta( $user_id, '_billing_phone', '0' . substr( $phone, 3 ) );

		return Response::ok( [ 'phoneUpdated' => true ] );
	}

	private function normalize_or_error( string $raw ): string|\WP_Error {
		$normalized = PhoneNormalizer::normalize( $raw );
		return $normalized ?? new \WP_Error( 'bc_invalid_phone' );
	}

	private function client_ip(): string {
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}

	private function otp_request_error_response( ?string $error_code ): \WP_REST_Response {
		return match ( $error_code ) {
			'cooldown'     => Response::error( 'bc_otp_cooldown', __( 'ارسال دوباره کد کمی بعد امکان‌پذیر است.', 'beauclick-auth' ), 429 ),
			'rate_limited' => Response::error( 'bc_otp_rate_limited', __( 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.', 'beauclick-auth' ), 429 ),
			default        => Response::error( 'bc_otp_send_failed', __( 'در ارسال کد تأیید مشکلی پیش آمد. لطفاً دوباره تلاش کنید.', 'beauclick-auth' ), 502 ),
		};
	}

	private function otp_verify_error_response( ?string $error_code ): \WP_REST_Response {
		return match ( $error_code ) {
			'invalid_code'       => Response::error( 'bc_otp_invalid', __( 'کد تأیید نادرست است.', 'beauclick-auth' ), 422 ),
			'too_many_attempts'  => Response::error( 'bc_otp_too_many_attempts', __( 'تعداد تلاش‌های شما بیش از حد مجاز است. لطفاً کد جدیدی درخواست کنید.', 'beauclick-auth' ), 429 ),
			default              => Response::error( 'bc_otp_expired', __( 'کد تأیید منقضی شده است. لطفاً دوباره درخواست دهید.', 'beauclick-auth' ), 422 ),
		};
	}
}
