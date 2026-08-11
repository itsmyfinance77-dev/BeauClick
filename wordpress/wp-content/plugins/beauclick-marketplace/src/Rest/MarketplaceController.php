<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;

/**
 * Public marketplace discovery: browse (filtered/sorted, backed by
 * wp_bc_provider_index — never live CPT meta queries, see Search\Indexer)
 * and single-provider detail (backed by the CPT + related posts, lower
 * traffic per-page so freshness matters more than raw query speed there).
 */
final class MarketplaceController extends RestController {

	public function register_routes(): void {
		$this->route(
			'/marketplace/providers',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'browse' ],
				'permission_callback' => '__return_true',
			]
		);

		$this->route(
			'/marketplace/providers/(?P<id>\d+)',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'detail' ],
				'permission_callback' => '__return_true',
				'args'                => [
					'id' => [ 'type' => 'integer', 'required' => true ],
				],
			]
		);
	}

	public function browse( WP_REST_Request $request ) {
		global $wpdb;
		[ $page, $per_page ] = $this->pagination_args( $request, 12, 48 );

		$where  = [ '1=1' ];
		$params = [];

		if ( $city_id = $request->get_param( 'city_id' ) ) {
			$where[]  = 'city_id = %d';
			$params[] = (int) $city_id;
		}
		if ( $district_id = $request->get_param( 'district_id' ) ) {
			$where[]  = 'district_id = %d';
			$params[] = (int) $district_id;
		}
		if ( $specialty_id = $request->get_param( 'specialty_id' ) ) {
			$where[]  = 'FIND_IN_SET(%d, specialty_ids)';
			$params[] = (int) $specialty_id;
		}
		if ( $price_max = $request->get_param( 'price_max' ) ) {
			$where[]  = 'price_from <= %d';
			$params[] = (int) $price_max;
		}
		if ( $rating_min = $request->get_param( 'rating_min' ) ) {
			$where[]  = 'rating_avg >= %f';
			$params[] = (float) $rating_min;
		}
		if ( rest_sanitize_boolean( $request->get_param( 'verified_only' ) ) ) {
			$where[] = 'verified = 1';
		}

		$table       = $wpdb->prefix . 'bc_provider_index';
		$where_sql   = implode( ' AND ', $where );
		$count_sql   = "SELECT COUNT(*) FROM {$table} WHERE {$where_sql}";
		$count_sql   = $params ? $wpdb->prepare( $count_sql, $params ) : $count_sql; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$total       = (int) $wpdb->get_var( $count_sql );

		$offset      = ( $page - 1 ) * $per_page;
		$order       = $this->sort_clause( (string) $request->get_param( 'sort' ) );
		$select_sql  = "SELECT * FROM {$table} WHERE {$where_sql} ORDER BY {$order} LIMIT %d OFFSET %d";
		$select_sql  = $wpdb->prepare( $select_sql, array_merge( $params, [ $per_page, $offset ] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

		$rows = $wpdb->get_results( $select_sql, ARRAY_A );

		return Response::paginated( array_map( [ $this, 'format_index_row' ], $rows ), $total, $page, $per_page );
	}

	private function sort_clause( string $sort ): string {
		return match ( $sort ) {
			'price_asc'  => 'price_from ASC',
			'price_desc' => 'price_from DESC',
			'rating'     => 'rating_avg DESC, review_count DESC',
			default      => 'verified DESC, rating_avg DESC', // "recommended" — real ranking_score lands in Phase 11.
		};
	}

	private function format_index_row( array $row ): array {
		return [
			'id'           => (int) $row['provider_id'],
			'type'         => $row['provider_type'],
			'name'         => $row['name'],
			'city_id'      => $row['city_id'] ? (int) $row['city_id'] : null,
			'district_id'  => $row['district_id'] ? (int) $row['district_id'] : null,
			'specialtyIds' => $row['specialty_ids'] ? array_map( 'intval', explode( ',', $row['specialty_ids'] ) ) : [],
			'priceFrom'    => null !== $row['price_from'] ? (int) $row['price_from'] : null,
			'rating'       => (float) $row['rating_avg'],
			'reviewCount'  => (int) $row['review_count'],
			'verified'     => (bool) $row['verified'],
		];
	}

	public function detail( WP_REST_Request $request ) {
		$id   = (int) $request->get_param( 'id' );
		$post = get_post( $id );

		if ( ! $post || ! in_array( $post->post_type, [ Registrar::PROFESSIONAL, Registrar::BUSINESS ], true ) || 'publish' !== $post->post_status ) {
			return Response::error( 'bc_not_found', __( 'Provider not found.', 'beauclick-marketplace' ), 404 );
		}

		$services = get_posts(
			[
				'post_type'      => Registrar::SERVICE,
				'post_parent'    => $id,
				'post_status'    => 'publish',
				'posts_per_page' => -1,
			]
		);

		$portfolio = get_posts(
			[
				'post_type'      => Registrar::PORTFOLIO_ITEM,
				'post_parent'    => $id,
				'post_status'    => 'publish',
				'posts_per_page' => -1,
			]
		);

		return Response::ok(
			[
				'id'          => $post->ID,
				'type'        => $post->post_type,
				'name'        => $post->post_title,
				'ownerUserId' => (int) $post->post_author,
				'bio'         => $post->post_content,
				'cityId'      => (int) get_post_meta( $id, '_bc_city_id', true ) ?: null,
				'districtId'  => (int) get_post_meta( $id, '_bc_district_id', true ) ?: null,
				'verified'    => 'verified' === get_post_meta( $id, '_bc_verification_status', true ),
				'specialties' => wp_get_post_terms( $id, Registrar::SPECIALTY, [ 'fields' => 'names' ] ),
				'services'    => array_map(
					static fn ( \WP_Post $s ) => [
						'id'              => $s->ID,
						'name'            => $s->post_title,
						'durationMinutes' => (int) get_post_meta( $s->ID, '_bc_duration_minutes', true ),
						'price'           => (int) get_post_meta( $s->ID, '_bc_price', true ),
					],
					$services
				),
				'portfolio'   => array_map(
					static fn ( \WP_Post $p ) => [
						'id'    => $p->ID,
						'title' => $p->post_title,
						'image' => get_the_post_thumbnail_url( $p->ID, 'large' ) ?: null,
					],
					$portfolio
				),
			]
		);
	}
}
