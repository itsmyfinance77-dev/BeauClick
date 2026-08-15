<?php
/**
 * Global helper, deliberately un-namespaced — same convention as every other
 * beauclick-*() helper in this codebase (beauclick_core(), beauclick_loyalty(),
 * beauclick_referral(), beauclick_notifications()).
 *
 * @package BeauClick\Campaigns
 */

declare( strict_types=1 );

if ( ! function_exists( 'beauclick_campaigns' ) ) {
	function beauclick_campaigns(): \BeauClick\Campaigns\CampaignService {
		return new \BeauClick\Campaigns\CampaignService();
	}
}
