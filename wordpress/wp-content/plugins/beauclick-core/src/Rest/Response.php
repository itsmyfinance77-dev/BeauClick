<?php
declare( strict_types=1 );

namespace BeauClick\Core\Rest;

use WP_REST_Response;

/**
 * Consistent response envelope for every beauclick/v1 endpoint:
 * { data, meta: { pagination? }, error: null }
 * Keeping this identical across all modules is what lets the app-shell's
 * API client (app/src/lib/api.ts) stay a single small wrapper instead of
 * per-endpoint parsing.
 */
final class Response {

	public static function ok( mixed $data, array $meta = [], int $status = 200 ): WP_REST_Response {
		return new WP_REST_Response(
			[
				'data'  => $data,
				'meta'  => (object) $meta,
				'error' => null,
			],
			$status
		);
	}

	public static function paginated( array $items, int $total, int $page, int $per_page, int $status = 200 ): WP_REST_Response {
		return self::ok(
			$items,
			[
				'pagination' => [
					'total'    => $total,
					'page'     => $page,
					'per_page' => $per_page,
					'pages'    => $per_page > 0 ? (int) ceil( $total / $per_page ) : 0,
				],
			],
			$status
		);
	}

	public static function error( string $code, string $message, int $status = 400, array $details = [] ): WP_REST_Response {
		return new WP_REST_Response(
			[
				'data'  => null,
				'meta'  => (object) [],
				'error' => [
					'code'    => $code,
					'message' => $message,
					'details' => (object) $details,
				],
			],
			$status
		);
	}
}
