<?php
declare( strict_types=1 );

namespace BeauClick\Notifications\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Notifications\Preferences\PreferenceService;
use WP_REST_Request;

/**
 * Customer routes are self-scoped (get_current_user_id() only, the same
 * "no route ever accepts a customer-supplied user id for their own data"
 * pattern every other controller in this codebase already follows). The
 * admin route is a small operational view (§28) for debugging delivery
 * problems -- not a general notification-center product surface.
 */
final class NotificationsController extends RestController {

	public function register_routes(): void {
		$this->route( '/notifications/preferences', [ 'methods' => 'GET', 'callback' => [ $this, 'get_preferences' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/notifications/preferences', [ 'methods' => 'PATCH', 'callback' => [ $this, 'update_preferences' ], 'permission_callback' => [ $this, 'require_login' ] ] );
		$this->route( '/notifications/mine', [ 'methods' => 'GET', 'callback' => [ $this, 'mine' ], 'permission_callback' => [ $this, 'require_login' ] ] );

		$this->route( '/notifications/admin/list', [ 'methods' => 'GET', 'callback' => [ $this, 'admin_list' ], 'permission_callback' => [ $this, 'require_admin' ] ] );
	}

	public function require_admin(): bool|\WP_Error {
		return $this->require_capability( 'bc_manage_platform' );
	}

	public function get_preferences(): \WP_REST_Response {
		return Response::ok( ( new PreferenceService() )->for_user( get_current_user_id() ) );
	}

	public function update_preferences( WP_REST_Request $request ): \WP_REST_Response {
		$updates = [];
		foreach ( PreferenceService::CATEGORIES as $category ) {
			if ( null !== $request->get_param( $category ) ) {
				$updates[ $category ] = (bool) $request->get_param( $category );
			}
		}
		return Response::ok( ( new PreferenceService() )->update( get_current_user_id(), $updates ) );
	}

	public function mine( WP_REST_Request $request ): \WP_REST_Response {
		$limit = min( 50, max( 1, (int) ( $request->get_param( 'per_page' ) ?: 30 ) ) );
		return Response::ok( beauclick_notifications()->for_user( get_current_user_id(), $limit ) );
	}

	public function admin_list( WP_REST_Request $request ): \WP_REST_Response {
		global $wpdb;
		[ $page, $per_page ] = $this->pagination_args( $request, 30, 100 );
		$offset = ( $page - 1 ) * $per_page;

		$status = $request->get_param( 'status' ) ? sanitize_key( (string) $request->get_param( 'status' ) ) : null;
		$where  = $status ? $wpdb->prepare( 'WHERE status = %s', $status ) : '';

		$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications {$where}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
		$rows  = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT id, user_id, category, template_key, channel, recipient, status, entity_type, entity_id, error, attempts, created_at, sent_at FROM {$wpdb->prefix}bc_notifications {$where} ORDER BY id DESC LIMIT %d OFFSET %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$per_page,
				$offset
			),
			ARRAY_A
		);

		$items = array_map(
			static fn ( array $r ) => [
				'id'          => (int) $r['id'],
				'userId'      => (int) $r['user_id'],
				'category'    => $r['category'],
				'templateKey' => $r['template_key'],
				'channel'     => $r['channel'],
				'recipient'   => $r['recipient'],
				'status'      => $r['status'],
				'entityType'  => $r['entity_type'],
				'entityId'    => $r['entity_id'] ? (int) $r['entity_id'] : null,
				'error'       => $r['error'],
				'attempts'    => (int) $r['attempts'],
				'createdAt'   => $r['created_at'],
				'sentAt'      => $r['sent_at'],
			],
			$rows ?: []
		);

		return Response::paginated( $items, $total, $page, $per_page );
	}
}
