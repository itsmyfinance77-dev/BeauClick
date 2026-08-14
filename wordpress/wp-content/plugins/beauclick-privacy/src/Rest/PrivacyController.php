<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Rest;

use BeauClick\Auth\Otp\OtpConfig;
use BeauClick\Auth\Otp\OtpService;
use BeauClick\Auth\Phone\PhoneLookup;
use BeauClick\Core\Rest\Response;
use BeauClick\Core\Rest\RestController;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Deletion\DeletionService;
use BeauClick\Privacy\Export\ExportService;
use BeauClick\Privacy\Export\ExportStorage;
use WP_REST_Request;

/**
 * Every route here is self-scoped (`get_current_user_id()`, never a
 * client-supplied user id) — matching JourneyController's/ReferralController's
 * own established convention exactly. Deletion additionally requires a
 * fresh OTP confirmation (§8/§28) — reusing beauclick-auth's existing
 * OtpService rather than building a second re-authentication mechanism.
 */
final class PrivacyController extends RestController {

	public function register_routes(): void {
		$this->route( '/privacy/export/status', [ 'methods' => 'GET', 'callback' => [ $this, 'export_status' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/privacy/export/request', [ 'methods' => 'POST', 'callback' => [ $this, 'export_request' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/privacy/export/download', [ 'methods' => 'GET', 'callback' => [ $this, 'export_download' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route( '/privacy/deletion/status', [ 'methods' => 'GET', 'callback' => [ $this, 'deletion_status' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/privacy/deletion/otp/request', [ 'methods' => 'POST', 'callback' => [ $this, 'deletion_otp_request' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/privacy/deletion/request', [ 'methods' => 'POST', 'callback' => [ $this, 'deletion_request' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/privacy/deletion/cancel', [ 'methods' => 'POST', 'callback' => [ $this, 'deletion_cancel' ], 'permission_callback' => [ $this, 'require_login' ] ] );
	}

	public function export_status(): \WP_REST_Response {
		$row = ( new DataRequestService() )->latest_for_user( get_current_user_id(), DataRequestService::TYPE_EXPORT );
		return Response::ok( $this->format_export( $row ) );
	}

	public function export_request(): \WP_REST_Response {
		$row = ( new ExportService() )->request( get_current_user_id() );
		return Response::ok( $this->format_export( $row ) );
	}

	/**
	 * Deliberately not Response::ok() -- streams the ZIP directly, the same
	 * shape VerificationController::download_evidence() already
	 * established for a protected-file download in this codebase.
	 */
	public function export_download( WP_REST_Request $request ) {
		$token = (string) $request->get_param( 'token' );
		if ( '' === $token ) {
			return Response::error( 'bc_invalid_input', __( 'نشانه دانلود نامعتبر است.', 'beauclick-privacy' ), 422 );
		}

		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_data_requests WHERE export_token = %s AND request_type = 'export'", $token ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		if ( ! $row || (int) $row['user_id'] !== get_current_user_id() ) {
			// Same shape whether the token is unknown or belongs to someone
			// else -- never lets a caller distinguish the two (no account/
			// token enumeration signal).
			return Response::error( 'bc_not_found', __( 'فایل خروجی پیدا نشد.', 'beauclick-privacy' ), 404 );
		}
		if ( DataRequestService::STATUS_READY !== $row['status'] || empty( $row['export_file'] ) ) {
			return Response::error( 'bc_not_ready', __( 'فایل خروجی آماده نیست.', 'beauclick-privacy' ), 404 );
		}
		if ( empty( $row['expires_at'] ) || strtotime( (string) $row['expires_at'] ) <= time() ) {
			return Response::error( 'bc_expired', __( 'مهلت دانلود این فایل به پایان رسیده است. لطفاً دوباره درخواست دهید.', 'beauclick-privacy' ), 410 );
		}

		$path = ( new ExportStorage() )->path_for( (string) $row['export_file'] );
		if ( ! file_exists( $path ) ) {
			return Response::error( 'bc_not_found', __( 'فایل خروجی پیدا نشد.', 'beauclick-privacy' ), 404 );
		}

		nocache_headers();
		header( 'Content-Type: application/zip' );
		header( 'Content-Length: ' . filesize( $path ) );
		header( 'Content-Disposition: attachment; filename="beauclick-my-data.zip"' );
		header( 'X-Content-Type-Options: nosniff' );
		readfile( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_read_readfile
		exit;
	}

	public function deletion_status(): \WP_REST_Response {
		$row = ( new DataRequestService() )->latest_for_user( get_current_user_id(), DataRequestService::TYPE_DELETION );
		return Response::ok( $this->format_deletion( $row ) );
	}

	public function deletion_otp_request(): \WP_REST_Response {
		$phone = PhoneLookup::for_user( get_current_user_id() );
		if ( ! $phone ) {
			return Response::error( 'bc_no_phone', __( 'شماره موبایل تأییدشده‌ای برای حساب شما یافت نشد.', 'beauclick-privacy' ), 422 );
		}

		$result = ( new OtpService() )->request_otp( $phone, OtpConfig::PURPOSE_CONFIRM_ACCOUNT_DELETION, get_current_user_id(), $this->client_ip() );
		if ( ! $result['ok'] ) {
			return match ( $result['errorCode'] ) {
				'cooldown'     => Response::error( 'bc_otp_cooldown', __( 'ارسال دوباره کد کمی بعد امکان‌پذیر است.', 'beauclick-privacy' ), 429 ),
				'rate_limited' => Response::error( 'bc_otp_rate_limited', __( 'تعداد درخواست‌های شما بیش از حد مجاز است.', 'beauclick-privacy' ), 429 ),
				default        => Response::error( 'bc_otp_send_failed', __( 'در ارسال کد تأیید مشکلی پیش آمد.', 'beauclick-privacy' ), 502 ),
			};
		}

		return Response::ok( [ 'sent' => true, 'phoneMasked' => \BeauClick\Auth\Phone\PhoneNormalizer::masked( $phone ), 'expiresInSeconds' => OtpConfig::EXPIRY_SECONDS ] );
	}

	public function deletion_request( WP_REST_Request $request ): \WP_REST_Response {
		$code = trim( (string) $request->get_param( 'code' ) );
		if ( '' === $code ) {
			return Response::error( 'bc_invalid_input', __( 'لطفاً کد تأیید را وارد کنید.', 'beauclick-privacy' ), 422 );
		}

		$user_id = get_current_user_id();
		$phone   = PhoneLookup::for_user( $user_id );
		if ( ! $phone ) {
			return Response::error( 'bc_no_phone', __( 'شماره موبایل تأییدشده‌ای برای حساب شما یافت نشد.', 'beauclick-privacy' ), 422 );
		}

		$verify = ( new OtpService() )->verify_otp( $phone, $code, OtpConfig::PURPOSE_CONFIRM_ACCOUNT_DELETION, $user_id );
		if ( ! $verify['ok'] ) {
			return match ( $verify['errorCode'] ) {
				'invalid_code'      => Response::error( 'bc_otp_invalid', __( 'کد تأیید نادرست است.', 'beauclick-privacy' ), 422 ),
				'too_many_attempts' => Response::error( 'bc_otp_too_many_attempts', __( 'تعداد تلاش‌های شما بیش از حد مجاز است.', 'beauclick-privacy' ), 429 ),
				default             => Response::error( 'bc_otp_expired', __( 'کد تأیید منقضی شده است. لطفاً دوباره درخواست دهید.', 'beauclick-privacy' ), 422 ),
			};
		}

		$result = ( new DeletionService() )->request_deletion( $user_id );
		return Response::ok( $result );
	}

	public function deletion_cancel( WP_REST_Request $request ): \WP_REST_Response {
		$request_id = (int) $request->get_param( 'requestId' );
		$cancelled  = ( new DeletionService() )->cancel( $request_id, get_current_user_id() );
		if ( ! $cancelled ) {
			return Response::error( 'bc_cannot_cancel', __( 'این درخواست دیگر قابل لغو نیست.', 'beauclick-privacy' ), 409 );
		}
		return Response::ok( [ 'cancelled' => true ] );
	}

	/**
	 * @return array<string, mixed>|null
	 *
	 * `downloadPath` is a relative REST path, NOT a ready-to-click URL --
	 * found live, during this step's own QA pass, that a plain `<a href>`
	 * built from `rest_url()` alone hits WordPress core's own REST cookie-
	 * auth CSRF guard: a same-origin GET navigation carries the auth
	 * cookie but no `X-WP-Nonce` header, and core's `rest_cookie_check_errors()`
	 * treats that as unauthenticated (401) even for the real, logged-in
	 * owner. The frontend must build the final href via `api.urlWithNonce()`
	 * (the same helper `VerificationModal`'s own evidence-download links
	 * already use) so a fresh nonce is attached at click time.
	 */
	private function format_export( ?array $row ): ?array {
		if ( ! $row ) {
			return null;
		}
		return [
			'id'           => (int) $row['id'],
			'status'       => $row['status'],
			'requestedAt'  => $row['requested_at'],
			'expiresAt'    => $row['expires_at'],
			'downloadPath' => DataRequestService::STATUS_READY === $row['status'] && $row['export_token']
				? '/privacy/export/download?token=' . rawurlencode( (string) $row['export_token'] )
				: null,
		];
	}

	/** @return array<string, mixed>|null */
	private function format_deletion( ?array $row ): ?array {
		if ( ! $row ) {
			return null;
		}
		return [
			'id'          => (int) $row['id'],
			'status'      => $row['status'],
			'reason'      => $row['reason'],
			'requestedAt' => $row['requested_at'],
			'reviewedAt'  => $row['reviewed_at'],
			'completedAt' => $row['completed_at'],
		];
	}

	private function client_ip(): string {
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}
}
