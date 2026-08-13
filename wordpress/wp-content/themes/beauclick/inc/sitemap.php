<?php
/**
 * V2.2 Step 12 — a custom sitemap provider for the marketplace's
 * city/specialty query-string landing pages (see inc/seo.php's own
 * docblock for why these stay query-string URLs rather than new pretty
 * paths). WordPress core's own wp-sitemap.xml (WP 5.5+, active by default,
 * unfiltered until this file) already covers `bc_professional`/
 * `bc_business` profile pages automatically since they're real, public,
 * `publicly_queryable` post types — nothing needed there. What core's
 * default sitemap can NEVER discover on its own is a query-string URL,
 * since it only walks real posts/taxonomy terms, not arbitrary parameter
 * combinations — that's the actual gap this file closes.
 *
 * Bounded and real-content-gated by construction, matching this step's own
 * explicit "avoid generating thousands of empty thin pages" instruction:
 * only launched cities (`is_launched = 1`), and only city×specialty pairs
 * with at least one real matching row in `wp_bc_provider_index` today. A
 * city or specialty with zero real matches simply isn't in this list — not
 * included-but-empty, not included-and-noindexed, just absent, since
 * inc/seo.php's own canonical/robots logic would collapse it to the plain
 * marketplace root anyway (see bc_get_meaningful_marketplace_filters()).
 *
 * The result set is small (bounded by launched-city count × specialty
 * count, realistically low tens to low hundreds of URLs for this product),
 * so it's computed directly per sitemap request rather than needing a
 * pre-computed cache table — consistent with this project's standing
 * "prefer the simplest approach that's sufficiently performant, don't
 * introduce caching infrastructure without evidence it's needed" position
 * (the same reasoning V2.2 Step 11's MetricsService documents for its own
 * live-aggregation-only choice).
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// wp_sitemaps_init, not the generic init -- WordPress core's own documented
// hook for third-party sitemap provider registration, fired from inside
// the sitemaps server's own bootstrap (wp-includes/sitemaps.php). Hooking
// plain `init` instead was a real bug found during this step's own live
// verification: it ran too early relative to the sitemaps registry's own
// construction, so the sitemap URL silently fell through to the front page
// (no 404, no error, just wrong content) -- exactly the kind of failure
// that "looks done" without being effective.
add_action( 'wp_sitemaps_init', 'bc_register_marketplace_sitemap_provider' );

function bc_register_marketplace_sitemap_provider(): void {
	if ( ! class_exists( 'WP_Sitemaps_Provider' ) ) {
		return; // Older WP core without the sitemaps feature -- degrade silently, no fatal.
	}
	wp_register_sitemap_provider( 'bclocations', new BC_Marketplace_Sitemap_Provider() );
}

/**
 * Excludes BeauClick's own genuinely private post types from the default
 * post-type sitemap, defense in depth on top of their own
 * `public => false` registration (Registrar.php) already keeping them out.
 * bc_professional/bc_business are deliberately left untouched here -- they
 * SHOULD be in the default sitemap, and already are.
 */
add_filter(
	'wp_sitemaps_post_types',
	static function ( array $post_types ): array {
		unset( $post_types['bc_service'], $post_types['bc_portfolio_item'] );
		return $post_types;
	}
);

if ( class_exists( 'WP_Sitemaps_Provider' ) ) :

	final class BC_Marketplace_Sitemap_Provider extends WP_Sitemaps_Provider {

		public function __construct() {
			// Deliberately hyphen-free: WP core's own sitemap rewrite rule
			// for a single-segment provider is `^wp-sitemap-([a-z]+?)-(\d+?)\.xml$`
			// -- the "type" capture group is pure `[a-z]+`, no hyphens/digits/
			// underscores allowed. A hyphenated name (the first, more
			// descriptive attempt here was `bc-marketplace-locations`) can
			// register successfully but its URL can never match this regex,
			// so it silently falls through to the front page instead of ever
			// rendering -- a second real bug this step's own live
			// verification caught.
			$this->name        = 'bclocations';
			$this->object_type = 'bc_marketplace_location';
		}

		/** @return array<int, array{loc: string}> */
		public function get_url_list( $page_num, $object_subtype = '' ) {
			if ( 1 !== $page_num ) {
				return []; // Small, bounded result set -- always fits on page 1 (see this file's own docblock).
			}

			$urls = [];
			foreach ( $this->real_combinations() as [ $city_id, $specialty_id ] ) {
				$args   = array_filter( [ 'city_id' => $city_id ?: null, 'specialty_id' => $specialty_id ?: null ] );
				$urls[] = [ 'loc' => add_query_arg( $args, home_url( '/marketplace/' ) ) ];
			}
			return $urls;
		}

		public function get_max_num_pages( $object_subtype = '' ) {
			return $this->real_combinations() ? 1 : 0;
		}

		/** @return list<array{0:int,1:int}> [city_id, specialty_id] pairs, specialty_id may be 0 (city-only page). */
		private function real_combinations(): array {
			global $wpdb;
			static $combinations = null;
			if ( null !== $combinations ) {
				return $combinations;
			}

			$combinations = [];

			$cities = $wpdb->get_results( "SELECT id FROM {$wpdb->prefix}bc_cities WHERE is_launched = 1", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery
			$specialties = get_terms( [ 'taxonomy' => 'bc_specialty', 'hide_empty' => false, 'fields' => 'ids' ] );
			$specialties = is_wp_error( $specialties ) ? [] : $specialties;

			foreach ( $cities as $city ) {
				$city_id = (int) $city['id'];
				if ( $this->has_real_content( $city_id, 0 ) ) {
					$combinations[] = [ $city_id, 0 ];
				}
				foreach ( $specialties as $specialty_id ) {
					if ( $this->has_real_content( $city_id, (int) $specialty_id ) ) {
						$combinations[] = [ $city_id, (int) $specialty_id ];
					}
				}
			}

			return $combinations;
		}

		private function has_real_content( int $city_id, int $specialty_id ): bool {
			global $wpdb;
			$where  = [ 'city_id = %d' ];
			$params = [ $city_id ];
			if ( $specialty_id ) {
				$where[]  = 'FIND_IN_SET(%d, specialty_ids)';
				$params[] = $specialty_id;
			}
			$sql = "SELECT 1 FROM {$wpdb->prefix}bc_provider_index WHERE " . implode( ' AND ', $where ) . ' LIMIT 1'; // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			return (bool) $wpdb->get_var( $wpdb->prepare( $sql, $params ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		}
	}

endif;
