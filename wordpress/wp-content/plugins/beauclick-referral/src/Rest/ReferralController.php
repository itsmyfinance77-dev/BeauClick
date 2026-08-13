<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Referral\ReferralService;
use WP_REST_Request;

/**
 * Self-scoped only, same pattern as LoyaltyController::summary() -- no
 * route here ever accepts a customer-supplied user id; the customer's own
 * code/history always comes from get_current_user_id() alone. The admin
 * route is a small operational list (matches
 * NotificationsController::admin_list()'s own scope and shape), not a
 * second analytics dashboard -- referral metrics/aggregates live in
 * beauclick-analytics's MetricsService::referral(), not here.
 */
final class ReferralController extends RestController {

	public function register_routes(): void {
		$this->route( '/referrals/summary', [ 'methods' => 'GET', 'callback' => [ $this, 'summary' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/referrals/admin/list', [ 'methods' => 'GET', 'callback' => [ $this, 'admin_list' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
	}

	public function require_admin(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function summary(): \WP_REST_Response {
		return Response::ok( ( new ReferralService() )->summary_for_user( get_current_user_id() ) );
	}

	public function admin_list( WP_REST_Request $request ): \WP_REST_Response {
		global $wpdb;
		[ $page, $per_page ] = $this->pagination_args( $request, 30, 100 );
		$offset = ( $page - 1 ) * $per_page;

		$status = $request->get_param( 'status' ) ? sanitize_key( (string) $request->get_param( 'status' ) ) : null;
		$where  = $status ? $wpdb->prepare( 'WHERE status = %s', $status ) : '';

		$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_referrals {$where}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, referrer_user_id, referee_user_id, code_used, status, created_at, qualified_at, rewarded_at FROM {$wpdb->prefix}bc_referrals {$where} ORDER BY id DESC LIMIT %d OFFSET %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$per_page,
				$offset
			),
			ARRAY_A
		);

		$items = array_map(
			static fn ( array $r ) => [
				'id'             => (int) $r['id'],
				'referrerUserId' => (int) $r['referrer_user_id'],
				'refereeUserId'  => (int) $r['referee_user_id'],
				'codeUsed'       => $r['code_used'],
				'status'         => $r['status'],
				'createdAt'      => $r['created_at'],
				'qualifiedAt'    => $r['qualified_at'],
				'rewardedAt'     => $r['rewarded_at'],
			],
			$rows ?: []
		);

		return Response::paginated( $items, $total, $page, $per_page );
	}
}
