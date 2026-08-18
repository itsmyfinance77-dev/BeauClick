<?php
/**
 * Template data helpers. Server-rendered pages read the search-index table
 * and location tables directly ($wpdb) rather than going through the REST
 * API — same data source, no HTTP round-trip needed for the page's own
 * server-side render.
 *
 * @package BeauClick\Theme
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const BC_PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

/**
 * Persian-digit formatting mirror of app/src/lib/format.ts — both exist
 * because one runs server-side (PHP-rendered pages) and one client-side
 * (React app-shell); kept in sync by hand since the logic is a handful of
 * lines, not worth a shared build step for.
 *
 * Accepts float too (not just string|int): round()/number_format()-style
 * arithmetic on prices/percentages naturally produces floats, and
 * strict_types=1 (used throughout this theme) won't coerce one to int at
 * the call site — this is the same TypeError class as the earlier
 * bc_get_city_name() fix (a $wpdb string that time, a float here), fixed
 * the same way: widen the shared helper once instead of trusting every
 * future call site to remember an explicit cast.
 */
function bc_persian_digits( string|int|float $input ): string {
	return strtr( (string) $input, [ '0' => BC_PERSIAN_DIGITS[0], '1' => BC_PERSIAN_DIGITS[1], '2' => BC_PERSIAN_DIGITS[2], '3' => BC_PERSIAN_DIGITS[3], '4' => BC_PERSIAN_DIGITS[4], '5' => BC_PERSIAN_DIGITS[5], '6' => BC_PERSIAN_DIGITS[6], '7' => BC_PERSIAN_DIGITS[7], '8' => BC_PERSIAN_DIGITS[8], '9' => BC_PERSIAN_DIGITS[9] ] );
}

function bc_format_toman( int $amount ): string {
	return bc_persian_digits( number_format( $amount, 0, '.', '٬' ) );
}

function bc_format_rating( float $rating ): string {
	return bc_persian_digits( number_format( $rating, 1 ) );
}

/** @return list<array{id:int, name_fa:string, slug:string}> */
function bc_get_launched_cities(): array {
	global $wpdb;
	$rows = $wpdb->get_results( "SELECT id, name_fa, slug FROM {$wpdb->prefix}bc_cities WHERE is_launched = 1 ORDER BY name_fa ASC", ARRAY_A );
	return $rows ?: [];
}

/**
 * Accepts int|string|null rather than a strict ?int on purpose: every
 * caller ultimately sources this from a $wpdb ARRAY_A row, and $wpdb
 * always returns numeric columns as strings — with strict_types=1 active
 * (every template in this theme has it), a bare `?int` parameter throws a
 * TypeError the moment a caller forgets an explicit (int) cast, which is
 * exactly what happened on the professional profile page. Casting once
 * here instead of trusting every call site to remember is the fix that
 * can't regress the same way again.
 */
function bc_get_city_name( int|string|null $city_id ): string {
	$city_id = $city_id ? (int) $city_id : null;
	if ( ! $city_id ) {
		return '';
	}
	global $wpdb;
	static $cache = [];
	if ( isset( $cache[ $city_id ] ) ) {
		return $cache[ $city_id ];
	}
	$name               = (string) $wpdb->get_var( $wpdb->prepare( "SELECT name_fa FROM {$wpdb->prefix}bc_cities WHERE id = %d", $city_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	$cache[ $city_id ]  = $name;
	return $name;
}

function bc_get_district_name( int|string|null $district_id ): string {
	$district_id = $district_id ? (int) $district_id : null;
	if ( ! $district_id ) {
		return '';
	}
	global $wpdb;
	return (string) $wpdb->get_var( $wpdb->prepare( "SELECT name_fa FROM {$wpdb->prefix}bc_districts WHERE id = %d", $district_id ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
}

/**
 * V2.4 Step 21: the same duplication RankingPresenter::ORDER_BY's own
 * comment already named ("the theme referencing a plugin class directly is
 * not a new pattern in kind") turned out to be real for the *whole* query,
 * not just the ORDER BY — this helper used to hand-roll its own
 * city/specialty/q WHERE clause, independently of and slightly differently
 * from MarketplaceController::browse()'s REST version of the same query.
 * Both now build a \BeauClick\Marketplace\Search\SearchQuery and delegate to
 * SqlSearchProvider — one query, whether the caller is this SSR helper or
 * the REST API (see that class's own docblock for the full reasoning).
 *
 * @return list<array<string,mixed>> unchanged shape — every existing caller
 *         (front-page.php's featured-providers rail) keeps working exactly
 *         as before. Callers that also need the search facts (zero-result,
 *         synonym-expanded) should call bc_search_providers() instead.
 */
function bc_get_providers( array $args = [] ): array {
	return bc_search_providers( $args )->rows;
}

/**
 * The richer sibling of bc_get_providers() — same query, but returns the
 * full \BeauClick\Marketplace\Search\SearchResult (total + whether a
 * curated synonym match expanded the query) rather than just the matched
 * rows. page-marketplace.php — the platform's actual live marketplace
 * search page — uses this so it can log a real search_performed event and
 * show the optional "نتایج مرتبط با …" hint; bc_get_providers() stays the
 * simple call for every other, non-search use (e.g. the homepage's
 * featured-providers rail, which is page content, not a user search).
 */
function bc_search_providers( array $args = [] ): \BeauClick\Marketplace\Search\SearchResult {
	if ( ! class_exists( \BeauClick\Marketplace\Search\SqlSearchProvider::class ) ) {
		return new \BeauClick\Marketplace\Search\SearchResult( [], 0, false );
	}

	$query = new \BeauClick\Marketplace\Search\SearchQuery(
		cityId: ! empty( $args['city_id'] ) ? (int) $args['city_id'] : null,
		specialtyId: ! empty( $args['specialty_id'] ) ? (int) $args['specialty_id'] : null,
		q: (string) ( $args['q'] ?? '' ),
		limit: (int) ( $args['limit'] ?? 12 )
	);

	return ( new \BeauClick\Marketplace\Search\SqlSearchProvider() )->search( $query );
}

/** @return list<\WP_Term> */
function bc_get_specialties(): array {
	$terms = get_terms( [ 'taxonomy' => 'bc_specialty', 'hide_empty' => false ] );
	return is_wp_error( $terms ) ? [] : $terms;
}

/** @return array<string,mixed>|null */
function bc_get_provider_index_row( int $provider_id ): ?array {
	global $wpdb;
	$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_provider_index WHERE provider_id = %d", $provider_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	return $row ?: null;
}

/** @return list<\WP_Post> */
function bc_get_provider_services( int $provider_id ): array {
	return get_posts(
		[
			'post_type'      => 'bc_service',
			'post_parent'    => $provider_id,
			'post_status'    => 'publish',
			'posts_per_page' => -1,
			'orderby'        => 'menu_order',
			'order'          => 'ASC',
		]
	);
}

function bc_provider_permalink( array $provider_row ): string {
	// get_permalink(), not a hand-built /professional/{id}/ path — WordPress
	// already knows the right URL shape for the current permalink settings
	// (pretty or plain), including this dev environment's plain permalinks
	// where a hand-built pretty path 404s with no rewrite rules active.
	return get_permalink( (int) $provider_row['provider_id'] ) ?: home_url( '/' );
}

/**
 * Temporary visual mockup asset resolver — reads `_bc_mockup_image`
 * postmeta (a bare filename under assets/mockups/, written only by the
 * demo/dev seeders — DemoProvidersSeed, DemoProductsSeed) rather than
 * WordPress's own attachment/Media-Library pipeline, deliberately: SVG is
 * not in WordPress's default `upload_mimes` allowlist (a real, intentional
 * XSS guard against arbitrary SVG uploads), and widening that allowlist
 * site-wide just to store a handful of trusted, developer-authored mockup
 * files is a real security-posture change this task has no reason to make.
 *
 * A real featured image (`has_post_thumbnail()`, set through the CPT's
 * already-registered `thumbnail` support once a real professional/business
 * uploads their own photo, or once a real production asset replaces a
 * mockup) always takes priority over the mockup meta — this function, and
 * every template that calls it, must never show a mockup once real content
 * exists. Returns null (never a broken path) when neither exists, so
 * callers fall back to the existing gradient `.bc-placeholder-image`
 * treatment — the honest "no photo yet" state stays unchanged for any
 * organically-created (non-demo) post.
 */
function bc_mockup_image_url( int $post_id ): ?string {
	if ( has_post_thumbnail( $post_id ) ) {
		return get_the_post_thumbnail_url( $post_id, 'medium' ) ?: null;
	}

	$file = get_post_meta( $post_id, '_bc_mockup_image', true );
	if ( ! $file || ! is_string( $file ) ) {
		return null;
	}

	// Defense in depth even though the value only ever comes from this
	// theme's own seeders, never user input: a bare filename only, no path
	// traversal, confined to the mockups directory.
	$file = basename( $file );
	if ( ! preg_match( '/^[a-z0-9\-]+\.svg$/', $file ) ) {
		return null;
	}

	return get_stylesheet_directory_uri() . '/assets/mockups/' . $file;
}
