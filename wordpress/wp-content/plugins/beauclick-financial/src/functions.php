<?php
/**
 * Global helper, deliberately un-namespaced — same convention as every other
 * beauclick-*() helper in this codebase.
 *
 * @package BeauClick\Financial
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_financial' ) ) {
	function beauclick_financial(): \BeauClick\Financial\LedgerService {
		return new \BeauClick\Financial\LedgerService();
	}
}
