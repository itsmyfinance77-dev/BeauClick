<?php
declare( strict_types=1 );

namespace BeauClick\Core\Support;

/**
 * Reads the single canonical design-token source (shared/design-tokens.json,
 * repo root) so the PHP-rendered theme and the React app-shell can never
 * drift — see architecture doc §18/§21. This class only *reads* the JSON and
 * exposes generated CSS custom properties for the theme to enqueue;
 * app/scripts/generate-tokens-css.mjs reads the same JSON independently for
 * the React side.
 */
final class Tokens {

	private static ?array $cache = null;

	public static function all(): array {
		if ( self::$cache !== null ) {
			return self::$cache;
		}

		$path = self::source_path();
		if ( ! file_exists( $path ) ) {
			self::$cache = [];
			return self::$cache;
		}

		$json        = file_get_contents( $path );
		self::$cache = json_decode( $json, true ) ?: [];

		return self::$cache;
	}

	public static function source_path(): string {
		// wp-content/plugins/beauclick-core/src/Support -> repo root/shared/design-tokens.json
		return dirname( BEAUCLICK_CORE_DIR, 4 ) . '/shared/design-tokens.json';
	}

	/**
	 * Flattens color/spacing/radius/shadow tokens into CSS custom properties,
	 * e.g. --bc-color-primary, --bc-radius-card. Typography is emitted as its
	 * own small set of properties rather than flattened, since its values are
	 * structured (responsive scale) rather than scalar.
	 */
	public static function to_css(): string {
		$tokens = self::all();
		if ( empty( $tokens ) ) {
			return '';
		}

		$lines = [ ':root {' ];

		foreach ( $tokens['color'] ?? [] as $name => $def ) {
			$lines[] = sprintf( '  --bc-color-%s: %s;', self::kebab( $name ), $def['value'] );
			if ( isset( $def['soft'] ) ) {
				$lines[] = sprintf( '  --bc-color-%s-soft: %s;', self::kebab( $name ), $def['soft'] );
			}
		}

		foreach ( $tokens['radius'] ?? [] as $name => $value ) {
			$lines[] = sprintf( '  --bc-radius-%s: %s;', self::kebab( $name ), $value );
		}

		foreach ( $tokens['spacing'] ?? [] as $name => $value ) {
			$lines[] = sprintf( '  --bc-space-%s: %s;', self::kebab( $name ), $value );
		}

		foreach ( $tokens['shadow'] ?? [] as $name => $value ) {
			$lines[] = sprintf( '  --bc-shadow-%s: %s;', self::kebab( $name ), $value );
		}

		if ( isset( $tokens['typography']['fontFamily'] ) ) {
			$lines[] = sprintf( '  --bc-font-family: %s;', $tokens['typography']['fontFamily'] );
		}

		if ( isset( $tokens['gradient']['brand'] ) ) {
			$lines[] = sprintf( '  --bc-gradient-brand: %s;', $tokens['gradient']['brand'] );
		}

		$lines[] = '}';

		return implode( "\n", $lines );
	}

	private static function kebab( string $camel ): string {
		return strtolower( (string) preg_replace( '/(?<!^)[A-Z]/', '-$0', $camel ) );
	}
}
