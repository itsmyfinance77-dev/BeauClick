<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use BeauClick\Marketplace\Verification\VerificationService;
use WP_REST_Request;

/**
 * Every route resolves the caller's own provider via ProviderLookup --
 * never a request-supplied provider id for the self-service routes --
 * matching the exact pattern CrmController/DashboardController already
 * established. The admin/queue routes are gated on `bc_moderate_verification`,
 * an existing-but-previously-unused RoleManager capability (moderator role
 * + admins, who inherit every moderator capability) -- not `bc_manage_platform`,
 * per the task's own "determine the appropriate capability, don't grant
 * authority merely because someone can reach wp-admin" instruction.
 */
final class VerificationController extends RestController {

	public function register_routes(): void {
		$this->route( '/marketplace/verification/me', [ 'methods' => 'GET', 'callback' => [ $this, 'me' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/marketplace/verification/submit', [ 'methods' => 'POST', 'callback' => [ $this, 'submit' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route(
			'/marketplace/verification/evidence/(?P<id>\d+)',
			[ 'methods' => 'GET', 'callback' => [ $this, 'download_evidence' ], 'permission_callback' => [ $this, 'require_login' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);

		$this->route( '/marketplace/verification/queue', [ 'methods' => 'GET', 'callback' => [ $this, 'queue' ], 'permission_callback' => [ $this, 'require_moderation' ] ] );
		$this->route(
			'/marketplace/verification/queue/(?P<id>\d+)/decide',
			[ 'methods' => 'POST', 'callback' => [ $this, 'decide' ], 'permission_callback' => [ $this, 'require_moderation' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
		$this->route(
			'/marketplace/verification/provider/(?P<id>\d+)/suspend',
			[ 'methods' => 'POST', 'callback' => [ $this, 'suspend' ], 'permission_callback' => [ $this, 'require_moderation' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
		$this->route(
			'/marketplace/verification/provider/(?P<id>\d+)/revoke',
			[ 'methods' => 'POST', 'callback' => [ $this, 'revoke' ], 'permission_callback' => [ $this, 'require_moderation' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
		$this->route(
			'/marketplace/verification/provider/(?P<id>\d+)/reinstate',
			[ 'methods' => 'POST', 'callback' => [ $this, 'reinstate' ], 'permission_callback' => [ $this, 'require_moderation' ], 'args' => [ 'id' => [ 'type' => 'integer', 'required' => true ] ] ]
		);
	}

	public function require_moderation(): bool|\WP_Error {
		return $this->require_capability( 'bc_moderate_verification' );
	}

	public function me( WP_REST_Request $request ) {
		$provider_id = ProviderLookup::for_user( get_current_user_id() );
		if ( ! $provider_id ) {
			return Response::error( 'bc_no_provider_profile', __( 'شما پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-marketplace' ), 404 );
		}
		return Response::ok( ( new VerificationService() )->summary( $provider_id ) );
	}

	public function submit( WP_REST_Request $request ) {
		$provider_id = ProviderLookup::for_user( get_current_user_id() );
		if ( ! $provider_id ) {
			return Response::error( 'bc_no_provider_profile', __( 'شما پروفایل متخصص یا کسب‌وکار ندارید.', 'beauclick-marketplace' ), 404 );
		}

		$files = $request->get_file_params()['evidence'] ?? null;
		$types = (array) $request->get_param( 'evidenceTypes' );

		$normalized_files = [];
		if ( is_array( $files ) && isset( $files['name'] ) && is_array( $files['name'] ) ) {
			// PHP's own multi-file $_FILES shape: parallel arrays, not one
			// entry per file -- must be un-transposed before use.
			foreach ( $files['name'] as $i => $name ) {
				$normalized_files[] = [
					'name'     => $name,
					'tmp_name' => $files['tmp_name'][ $i ] ?? '',
					'size'     => $files['size'][ $i ] ?? 0,
					'error'    => $files['error'][ $i ] ?? UPLOAD_ERR_NO_FILE,
					'type'     => $files['type'][ $i ] ?? '',
				];
			}
		} elseif ( is_array( $files ) && isset( $files['name'] ) ) {
			$normalized_files[] = $files; // Single-file shape.
		}

		$result = ( new VerificationService() )->submit_request( $provider_id, get_current_user_id(), $normalized_files, $types );
		if ( is_wp_error( $result ) ) {
			$data = $result->get_error_data();
			return Response::error( $result->get_error_code(), $result->get_error_message(), is_array( $data ) ? ( $data['status'] ?? 400 ) : 400 );
		}

		return Response::ok( $result, [], 201 );
	}

	public function download_evidence( WP_REST_Request $request ) {
		$evidence_id = (int) $request->get_param( 'id' );
		$service     = new VerificationService();
		$row         = $service->evidence_storage_key( $evidence_id );

		if ( ! $row ) {
			return Response::error( 'bc_not_found', __( 'مدرک پیدا نشد.', 'beauclick-marketplace' ), 404 );
		}

		$own_provider_id = ProviderLookup::for_user( get_current_user_id() );
		$is_owner        = $own_provider_id && $own_provider_id === (int) $row['provider_id'];
		$is_moderator    = current_user_can( 'bc_moderate_verification' );

		if ( ! $is_owner && ! $is_moderator ) {
			return Response::error( 'bc_forbidden', __( 'شما اجازه دسترسی به این مدرک را ندارید.', 'beauclick-marketplace' ), 403 );
		}

		$path = $service->storage()->path_for( $row['storage_key'] );
		if ( ! file_exists( $path ) ) {
			return Response::error( 'bc_not_found', __( 'فایل این مدرک دیگر در دسترس نیست.', 'beauclick-marketplace' ), 404 );
		}

		// A real file stream, not a REST-envelope JSON response -- this is
		// the one route in this codebase that deliberately doesn't return
		// Response::ok(). Every check above still ran first.
		nocache_headers();
		header( 'Content-Type: ' . $row['mime_type'] );
		header( 'Content-Length: ' . filesize( $path ) );
		header( 'Content-Disposition: inline; filename="' . rawurlencode( $row['original_filename'] ) . '"' );
		header( 'X-Content-Type-Options: nosniff' );
		readfile( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_read_readfile
		exit;
	}

	public function queue( WP_REST_Request $request ): \WP_REST_Response {
		global $wpdb;
		[ $page, $per_page ] = $this->pagination_args( $request, 20, 50 );
		$offset = ( $page - 1 ) * $per_page;

		$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_verification_requests WHERE status = 'pending'" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_verification_requests WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT %d OFFSET %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$per_page,
				$offset
			),
			ARRAY_A
		);

		$items = array_map(
			static function ( array $r ) use ( $wpdb ) {
				$provider     = get_post( (int) $r['provider_id'] );
				$evidence_ids = $wpdb->get_col( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_verification_evidence WHERE request_id = %d", (int) $r['id'] ) );
				return [
					'requestId'    => (int) $r['id'],
					'providerId'   => (int) $r['provider_id'],
					'providerName' => $provider ? $provider->post_title : '',
					'providerType' => $provider ? $provider->post_type : '',
					'submittedAt'  => $r['submitted_at'],
					'evidenceIds'  => array_map( 'intval', $evidence_ids ),
				];
			},
			$rows
		);

		return Response::paginated( $items, $total, $page, $per_page );
	}

	public function decide( WP_REST_Request $request ) {
		$decision = (string) $request->get_param( 'decision' );
		$reason   = (string) $request->get_param( 'reason' );

		if ( 'rejected' === $decision && '' === trim( $reason ) ) {
			return Response::error( 'bc_reason_required', __( 'برای رد درخواست، ذکر دلیل الزامی است.', 'beauclick-marketplace' ), 422 );
		}

		$result = ( new VerificationService() )->decide( (int) $request->get_param( 'id' ), get_current_user_id(), $decision, $reason );
		return $this->respond( $result );
	}

	public function suspend( WP_REST_Request $request ) {
		$reason = (string) $request->get_param( 'reason' );
		if ( '' === trim( $reason ) ) {
			return Response::error( 'bc_reason_required', __( 'برای تعلیق، ذکر دلیل الزامی است.', 'beauclick-marketplace' ), 422 );
		}
		$result = ( new VerificationService() )->suspend( (int) $request->get_param( 'id' ), get_current_user_id(), $reason );
		return $this->respond( $result );
	}

	public function revoke( WP_REST_Request $request ) {
		$reason = (string) $request->get_param( 'reason' );
		if ( '' === trim( $reason ) ) {
			return Response::error( 'bc_reason_required', __( 'برای لغو تأیید، ذکر دلیل الزامی است.', 'beauclick-marketplace' ), 422 );
		}
		$result = ( new VerificationService() )->revoke( (int) $request->get_param( 'id' ), get_current_user_id(), $reason );
		return $this->respond( $result );
	}

	public function reinstate( WP_REST_Request $request ) {
		$reason = (string) $request->get_param( 'reason' );
		$result = ( new VerificationService() )->reinstate( (int) $request->get_param( 'id' ), get_current_user_id(), $reason );
		return $this->respond( $result );
	}

	private function respond( $result ): \WP_REST_Response {
		if ( is_wp_error( $result ) ) {
			$data = $result->get_error_data();
			return Response::error( $result->get_error_code(), $result->get_error_message(), is_array( $data ) ? ( $data['status'] ?? 400 ) : 400 );
		}
		return Response::ok( [ 'ok' => true ] );
	}
}
