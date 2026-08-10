<?php
/**
 * Loads repo-root .env into constants, then wp-config.php uses those
 * constants instead of hardcoded credentials/keys. No third-party dotenv
 * dependency — the parsing need here is trivial (KEY=VALUE lines, # comments)
 * and doesn't justify a Composer package.
 *
 * wp-config.php (generated locally by the WordPress installer, not
 * committed) should require this file before defining DB_NAME etc.:
 *
 *   require_once __DIR__ . '/bootstrap-env.php';
 *   define( 'DB_NAME', BC_ENV['DB_NAME'] );
 *   define( 'DB_USER', BC_ENV['DB_USER'] );
 *   ...
 */

declare( strict_types=1 );

if ( ! defined( 'BC_ENV' ) ) {
	$bc_env_path = dirname( __DIR__ ) . '/.env';
	$bc_env      = [];

	if ( file_exists( $bc_env_path ) ) {
		foreach ( file( $bc_env_path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) as $line ) {
			$line = trim( $line );
			if ( '' === $line || str_starts_with( $line, '#' ) || ! str_contains( $line, '=' ) ) {
				continue;
			}
			[ $key, $value ] = explode( '=', $line, 2 );
			$bc_env[ trim( $key ) ] = trim( $value );
		}
	}

	define( 'BC_ENV', $bc_env );
}

/**
 * @param string $key
 * @param string $default
 */
function bc_env( string $key, string $default = '' ): string {
	return BC_ENV[ $key ] ?? $default;
}
