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
 */
function bc_persian_digits( string|int $input ): string {
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

function bc_get_city_name( ?int $city_id ): string {
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

function bc_get_district_name( ?int $district_id ): string {
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
	$sql   = "SELECT * FROM {$table} WHERE " . implode( ' AND ', $where ) . ' ORDER BY verified DESC, rating_avg DESC LIMIT %d';
	$sql   = $wpdb->prepare( $sql, array_merge( $params, [ $limit ] ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared

	return $wpdb->get_results( $sql, ARRAY_A ) ?: [];
}

/** @return list<\WP_Term> */
function bc_get_specialties(): array {
	$terms = get_terms( [ 'taxonomy' => 'bc_specialty', 'hide_empty' => false ] );
	return is_wp_error( $terms ) ? [] : $terms;
}

function bc_provider_permalink( array $provider_row ): string {
	return home_url( '/professional/' . (int) $provider_row['provider_id'] . '/' );
}
