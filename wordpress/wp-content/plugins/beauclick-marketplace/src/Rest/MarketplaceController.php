<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Rest;

use BeauClick\Core\Rest\RestController;
use BeauClick\Core\Rest\Response;
use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Ranking\RankingPresenter;
use BeauClick\Marketplace\Search\SearchQuery;
use BeauClick\Marketplace\Search\SqlSearchProvider;
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
		[ $page, $per_page ] = $this->pagination_args( $request, 12, 48 );

		$city_id      = (int) $request->get_param( 'city_id' ) ?: null;
		$district_id  = (int) $request->get_param( 'district_id' ) ?: null;
		$specialty_id = (int) $request->get_param( 'specialty_id' ) ?: null;
		$price_max    = $request->get_param( 'price_max' ) ? (int) $request->get_param( 'price_max' ) : null;
		$rating_min   = $request->get_param( 'rating_min' ) ? (float) $request->get_param( 'rating_min' ) : null;
		$q            = trim( (string) $request->get_param( 'q' ) );

		// V2.4 Step 21: query-building itself now lives in SqlSearchProvider,
		// shared with the theme's SSR bc_get_providers() helper — see that
		// class's own docblock for why (this duplication was real and
		// confirmed, not hypothetical).
		$result = ( new SqlSearchProvider() )->search(
			new SearchQuery(
				cityId: $city_id,
				districtId: $district_id,
				specialtyId: $specialty_id,
				priceMax: $price_max,
				ratingMin: $rating_min,
				verifiedOnly: rest_sanitize_boolean( $request->get_param( 'verified_only' ) ),
				q: $q,
				sort: (string) $request->get_param( 'sort' ),
				limit: $per_page,
				offset: ( $page - 1 ) * $per_page
			)
		);

		// V2.2 Step 11 (ANLYT-02), extended in V2.3 Step 20 once a real
		// free-text query param existed, and again in V2.4 Step 21: this
		// filtered browse is the platform's real search/discovery entry
		// point. No idempotency guard, same reasoning as profile_view below:
		// every real search is a distinct, legitimate event. Deliberately
		// logs only bounded counts and filter-usage booleans, never the raw
		// query text itself (privacy-conscious, matching this codebase's own
		// "allow-listed, bounded, no raw sensitive text" analytics
		// standard). `matchedResultCount`/`zeroResult` replace the old,
		// single `resultCount` field (same value, split so MetricsService
		// can read the zero-result fact directly instead of casting a
		// number out of JSON); `searchSource` distinguishes this REST path
		// from the SSR marketplace page, which logs the identical event
		// shape from page-marketplace.php now that it's the platform's
		// actual live search entry point (see that file's own comment).
		if ( function_exists( 'beauclick_core' ) ) {
			beauclick_core()->events()->log(
				'search_performed',
				'search',
				0,
				get_current_user_id() ?: null,
				[
					'matchedResultCount' => $result->total,
					'zeroResult'         => $result->isZeroResult(),
					'specialtyFilter'    => null !== $specialty_id,
					'locationFilter'     => null !== $city_id || null !== $district_id,
					'textSearch'         => '' !== $q,
					'searchSource'       => 'rest_api',
				]
			);
		}

		return Response::paginated( array_map( [ $this, 'format_index_row' ], $result->rows ), $result->total, $page, $per_page );
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
