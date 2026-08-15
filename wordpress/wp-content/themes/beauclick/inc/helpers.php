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

/** @return list<array<string,mixed>> */
function bc_get_providers( array $args = [] ): array {
	global $wpdb;
	$table  = $wpdb->prefix . 'bc_provider_index';
	$where  = [ '1=1' ];
	$params = [];

	if ( ! empty( $args['city_id'] ) ) {
		$where[]  = 'city_id = %d';
		$params[] = (int) $args['city_id'];
	}
	if ( ! empty( $args['specialty_id'] ) ) {
		$where[]  = 'FIND_IN_SET(%d, specialty_ids)';
		$params[] = (int) $args['specialty_id'];
	}

	$limit = (int) ( $args['limit'] ?? 12 );
	// V2.0 Step 3: same ORDER BY every ranking consumer in the codebase now
	// shares (REST API, AI recommendations, this SSR helper) — see
	// \BeauClick\Marketplace\Ranking\RankingPresenter's own docblock. The
	// theme referencing a plugin class directly is new here but not a new
	// pattern in kind: PHP's autoloader is process-wide once any plugin
	// registers it (beauclick-ai already calls marketplace classes the same
	// way), and duplicating this ORDER BY as a fourth hand-copied string was
	// the exact drift this step exists to remove.
	$order = class_exists( \BeauClick\Marketplace\Ranking\RankingPresenter::class )
		? \BeauClick\Marketplace\Ranking\RankingPresenter::ORDER_BY
		: 'verified DESC, rating_avg DESC';
	$sql   = "SELECT * FROM {$table} WHERE " . implode( ' AND ', $where ) . " ORDER BY {$order} LIMIT %d"; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
	$sql   = $wpdb->prepare( $sql, array_merge( $params, [ $limit ] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

	return $wpdb->get_results( $sql, ARRAY_A ) ?: [];
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
