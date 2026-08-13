<?php
/**
 * Global helper, deliberately un-namespaced — same reasoning as every
 * other beauclick-*() helper in this codebase (beauclick_core(),
 * beauclick_loyalty(), beauclick_notifications(), beauclick_analytics()).
 *
 * @package BeauClick\Referral
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_referral' ) ) {
	function beauclick_referral(): \BeauClick\Referral\ReferralService {
		return new \BeauClick\Referral\ReferralService();
	}
}
