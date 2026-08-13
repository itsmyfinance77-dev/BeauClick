<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Ranking\RankingPresenter;
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

		// V2.0 Step 4: Beauty Journey's goal/profile forms need a real
		// specialty picker (so a goal's specialtyId can genuinely feed AI
		// context -- see beauclick-journey\Context\JourneyContextProvider).
		// bc_specialty is show_in_rest=true, but that exposes it under
		// wp/v2, a different envelope shape (no {data,meta,error}) the
		// frontend's api.ts wrapper doesn't parse -- same read-only,
		// public, reference-data pattern as LocationsController's own
		// get_provinces(), just in the beauclick/v1 namespace this app
		// shell already speaks.
		$this->route( '/marketplace/specialties', [ 'methods' => 'GET', 'callback' => [ $this, 'specialties' ], 'permission_callback' => '__return_true' ] );
	}

	public function specialties(): \WP_REST_Response {
		$terms = get_terms( [ 'taxonomy' => Registrar::SPECIALTY, 'hide_empty' => false ] );
		if ( is_wp_error( $terms ) ) {
			return Response::ok( [] );
		}
		return Response::ok(
			array_map(
				static fn ( \WP_Term $t ) => [ 'id' => $t->term_id, 'name' => $t->name ],
				$terms
			)
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

		// V2.2 Step 11 (ANLYT-02): this filtered browse is the platform's
		// real search/discovery entry point today (there is no separate
		// free-text search endpoint — see MKT-02 in the gap register for
		// that distinct, deferred gap). No idempotency guard, same
		// reasoning as profile_view below: every real search is a distinct,
		// legitimate event. Deliberately logs only bounded counts and
		// filter-usage booleans, never raw query text — there is no
		// free-text query param on this endpoint to begin with.
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log(
				'search_performed',
				'search',
				0,
				get_current_user_id() ?: null,
				[
					'resultCount'     => $total,
					'specialtyFilter' => (bool) $specialty_id,
					'locationFilter'  => (bool) ( $city_id || $district_id ),
				]
			);
		}

		return Response::paginated( array_map( [ $this, 'format_index_row' ], $rows ), $total, $page, $per_page );
	}

	private function sort_clause( string $sort ): string {
		return match ( $sort ) {
			'price_asc'  => 'price_from ASC',
			'price_desc' => 'price_from DESC',
			'rating'     => 'rating_avg DESC, review_count DESC',
			// V2.0 Step 3: "recommended" — the real ranking engine this
			// comment used to point at as a future Phase 11. RankingPresenter
			// is the single shared ORDER_BY every ranking consumer in this
			// codebase now uses (see its own docblock).
			default      => RankingPresenter::ORDER_BY,
		};
	}

	private function format_index_row( array $row ): array {
		return [
			'id'             => (int) $row['provider_id'],
			'type'           => $row['provider_type'],
			'name'           => $row['name'],
			'city_id'        => $row['city_id'] ? (int) $row['city_id'] : null,
			'district_id'    => $row['district_id'] ? (int) $row['district_id'] : null,
			'specialtyIds'   => $row['specialty_ids'] ? array_map( 'intval', explode( ',', $row['specialty_ids'] ) ) : [],
			'priceFrom'      => null !== $row['price_from'] ? (int) $row['price_from'] : null,
			'rating'         => (float) $row['rating_avg'],
			'reviewCount'    => (int) $row['review_count'],
			'verified'       => (bool) $row['verified'],
			// V2.0 Step 3: truthful, pre-computed explanation phrases only —
			// never the raw internal ranking_score itself (roadmap's own
			// "do not expose meaningless scores" requirement).
			'rankingReasons' => RankingPresenter::explain( $row['ranking_signals'] ? (array) json_decode( (string) $row['ranking_signals'], true ) : [] ),
		];
	}

	public function detail( WP_REST_Request $request ) {
		$id   = (int) $request->get_param( 'id' );
		$post = get_post( $id );

		if ( ! $post || ! in_array( $post->post_type, [ Registrar::PROFESSIONAL, Registrar::BUSINESS ], true ) || 'publish' !== $post->post_status ) {
			return Response::error( 'bc_not_found', __( 'این پروفایل پیدا نشد.', 'beauclick-marketplace' ), 404 );
		}

		// V2.0 Step 1: profile_view was already a documented event type
		// (EventLogger's own docblock) that nothing ever actually logged.
		// Intentionally no idempotency guard — every real page view is a
		// distinct, legitimate event, not a duplicate to suppress.
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log( 'profile_view', $post->post_type, $id, get_current_user_id() ?: null );
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
