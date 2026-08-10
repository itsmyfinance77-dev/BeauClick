<?php
declare( strict_types=1 );

namespace BeauClick\Locations\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use WP_REST_Request;

/**
 * Public, read-only location lookups — powers the marketplace/shop location
 * filters and any location <select>/autocomplete in the app-shell. No
 * capability required: this is reference data, not user data.
 */
final class LocationsController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/locations/provinces',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_provinces' ],
				'permission_callback' => '__return_true',
			]
		);

		$this->route(
			'/locations/cities',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_cities' ],
				'permission_callback' => '__return_true',
				'args'                => [
					'province_id' => [ 'type' => 'integer', 'required' => false ],
					'launched'    => [ 'type' => 'boolean', 'required' => false ],
				],
			]
		);

		$this->route(
			'/locations/districts',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'get_districts' ],
				'permission_callback' => '__return_true',
				'args'                => [
					'city_id' => [ 'type' => 'integer', 'required' => true ],
				],
			]
		);
	}

	public function get_provinces() {
		global $wpdb;
		$rows = $wpdb->get_results( "SELECT id, name_fa, slug FROM {$wpdb->prefix}bc_provinces ORDER BY name_fa ASC", ARRAY_A );
		return Response::ok( $rows );
	}

	public function get_cities( WP_REST_Request $request ) {
		global $wpdb;

		$where  = [ '1=1' ];
		$params = [];

		$province_id = $request->get_param( 'province_id' );
		if ( $province_id ) {
			$where[]  = 'province_id = %d';
			$params[] = (int) $province_id;
		}

		if ( $request->has_param( 'launched' ) && rest_sanitize_boolean( $request->get_param( 'launched' ) ) ) {
			$where[] = 'is_launched = 1';
		}

		$sql = "SELECT id, province_id, name_fa, slug, is_launched FROM {$wpdb->prefix}bc_cities WHERE " . implode( ' AND ', $where ) . ' ORDER BY is_launched DESC, name_fa ASC';
		$sql = $params ? $wpdb->prepare( $sql, $params ) : $sql; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $sql, ARRAY_A );
		return Response::ok( $rows );
	}

	public function get_districts( WP_REST_Request $request ) {
		global $wpdb;
		$city_id = (int) $request->get_param( 'city_id' );

		$rows = $wpdb->get_results(
			$wpdb->prepare( "SELECT id, city_id, name_fa, slug FROM {$wpdb->prefix}bc_districts WHERE city_id = %d ORDER BY name_fa ASC", $city_id ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		return Response::ok( $rows );
	}
}
