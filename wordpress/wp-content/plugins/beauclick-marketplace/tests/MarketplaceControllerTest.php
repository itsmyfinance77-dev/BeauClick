<?php
declare( strict_types=1 );

namespace BeauClick\Marketplace\Tests;

use BeauClick\Marketplace\PostTypes\Registrar;
use BeauClick\Marketplace\Rest\MarketplaceController;
use WP_UnitTestCase;

final class MarketplaceControllerTest extends WP_UnitTestCase {

	/**
	 * V2.0 Step 1: profile_view was a documented event type nothing ever
	 * actually logged. Intentionally not deduplicated -- two real views
	 * must write two real rows, unlike the guarded order_completed/
	 * order_refunded events elsewhere in this task.
	 */
	public function test_viewing_a_profile_writes_a_profile_view_event_every_time(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$viewer_id   = self::factory()->user->create();
		wp_set_current_user( $viewer_id );

		$controller = new MarketplaceController();
		$request    = new \WP_REST_Request( 'GET', "/beauclick/v1/marketplace/providers/{$provider_id}" );
		$request->set_param( 'id', $provider_id );

		$controller->detail( $request );
		$controller->detail( $request );

		$count = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'profile_view' AND entity_type = %s AND entity_id = %d",
				Registrar::PROFESSIONAL,
				$provider_id
			)
		);
		$this->assertSame( 2, $count, 'Every real profile view is a distinct event -- two views must write two rows, not be deduplicated.' );
	}

	public function test_viewing_a_nonexistent_profile_does_not_write_an_event(): void {
		global $wpdb;
		$controller = new MarketplaceController();
		$request    = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers/999999' );
		$request->set_param( 'id', 999999 );

		$controller->detail( $request );

		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_events WHERE event_type = 'profile_view'" );
		$this->assertSame( 0, $count, 'A 404 profile lookup must never write a profile_view event.' );
	}
}
