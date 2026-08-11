<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\Support\ProviderLookup;
use WP_REST_Request;

/**
 * Professional dashboard "Overview" data (design handoff §7) — lives in
 * beauclick-booking because bookings are what most of this reads, and
 * booking already depends on marketplace (for the provider_index rating),
 * keeping the one-directional module dependency chain intact rather than
 * marketplace reaching into booking's tables.
 */
final class DashboardController extends RestController {

	public function register_routes(): void {
		$this->route( '/booking/my/stats', [ 'methods' => 'GET', 'callback' => [ $this, 'stats' ], 'permission_callback' => [ $this, 'require_login' ] ] );
	}

	public function stats( WP_REST_Request $request ): \WP_REST_Response {
		global $wpdb;
		// bc_bookings.provider_id is the owning CPT post id, not the WP user
		// id — see ProviderLookup. A logged-in professional with no profile
		// post yet (just registered) legitimately has all-zero stats rather
		// than an error.
		$provider_id = ProviderLookup::for_user( get_current_user_id() );
		if ( ! $provider_id ) {
			return Response::ok(
				[
					'todaysBookings' => 0,
					'monthRevenue'   => 0,
					'newClients'     => 0,
					'rating'         => 0.0,
					'reviewCount'    => 0,
					'weeklyBookings' => [],
					'todayUpcoming'  => [],
					'recentBookings' => [],
				]
			);
		}
		$bookings = $wpdb->prefix . 'bc_bookings';

		$today_start = current_time( 'Y-m-d' ) . ' 00:00:00';
		$today_end   = current_time( 'Y-m-d' ) . ' 23:59:59';
		$month_start = current_time( 'Y-m-01' ) . ' 00:00:00';

		$todays_bookings = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$bookings} WHERE provider_id = %d AND slot_start BETWEEN %s AND %s AND status IN ('confirmed','completed')", $provider_id, $today_start, $today_end ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		$new_clients = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(DISTINCT customer_id) FROM {$bookings} WHERE provider_id = %d AND created_at >= %s", $provider_id, $month_start ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);

		$order_ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT wc_order_id FROM {$bookings} WHERE provider_id = %d AND status IN ('confirmed','completed') AND created_at >= %s AND wc_order_id IS NOT NULL", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$provider_id,
				$month_start
			)
		);
		$month_revenue = 0;
		// A production-readiness audit caught this as an N+1: a wc_get_order()
		// call per booking meant a busy professional's dashboard load did one
		// extra DB query per paid booking that month. wc_get_orders() with
		// post__in fetches them all in a single query regardless of whether
		// WooCommerce is on legacy CPT or HPOS order storage.
		if ( $order_ids && function_exists( 'wc_get_orders' ) ) {
			$orders = wc_get_orders( [ 'post__in' => array_map( 'intval', $order_ids ), 'limit' => -1, 'return' => 'objects' ] );
			foreach ( $orders as $order ) {
				$month_revenue += (int) $order->get_total();
			}
		}

		$rating_row = $wpdb->get_row(
			$wpdb->prepare( "SELECT rating_avg, review_count FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		$weekly = [];
		for ( $i = 6; $i >= 0; $i-- ) {
			$date       = gmdate( 'Y-m-d', strtotime( current_time( 'Y-m-d' ) ) - $i * DAY_IN_SECONDS );
			$count      = (int) $wpdb->get_var(
				$wpdb->prepare( "SELECT COUNT(*) FROM {$bookings} WHERE provider_id = %d AND DATE(slot_start) = %s AND status IN ('confirmed','completed')", $provider_id, $date ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			);
			$weekly[]   = [ 'date' => $date, 'count' => $count ];
		}

		$today_upcoming = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$bookings} WHERE provider_id = %d AND slot_start BETWEEN %s AND %s AND status = 'confirmed' ORDER BY slot_start ASC", $provider_id, current_time( 'mysql' ), $today_end ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		$recent = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$bookings} WHERE provider_id = %d ORDER BY created_at DESC LIMIT 10", $provider_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);

		return Response::ok(
			[
				'todaysBookings' => $todays_bookings,
				'monthRevenue'   => $month_revenue,
				'newClients'     => $new_clients,
				'rating'         => (float) ( $rating_row['rating_avg'] ?? 0 ),
				'reviewCount'    => (int) ( $rating_row['review_count'] ?? 0 ),
				'weeklyBookings' => $weekly,
				'todayUpcoming'  => array_map( [ $this, 'format_booking' ], $today_upcoming ),
				'recentBookings' => array_map( [ $this, 'format_booking' ], $recent ),
			]
		);
	}

	private function format_booking( array $row ): array {
		$customer = get_userdata( (int) $row['customer_id'] );
		return [
			'id'         => (int) $row['id'],
			'customerName' => $customer ? $customer->display_name : '',
			'slotStart'  => $row['slot_start'],
			'status'     => $row['status'],
		];
	}
}
