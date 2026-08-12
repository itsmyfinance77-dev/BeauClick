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

	/**
	 * V2.0 Step 3: the default "recommended" browse sort now orders by the
	 * real ranking_score (via RankingPresenter::ORDER_BY) instead of the old
	 * hardcoded 'verified DESC, rating_avg DESC' -- a provider with a
	 * manually-set HIGHER ranking_score but a WORSE raw rating must still
	 * come first, proving the real column drives ordering, not the old
	 * fallback fields alone (verified DESC, rating_avg DESC are still the
	 * tiebreak chain, but must not be able to override a real score gap).
	 */
	public function test_the_default_browse_sort_orders_by_real_ranking_score(): void {
		global $wpdb;
		$owner_id = self::factory()->user->create();
		$low_score  = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'Low Score' ] );
		$high_score = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'High Score' ] );

		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'ranking_score' => 20.0, 'rating_avg' => 5.0, 'verified' => 1 ], [ 'provider_id' => $low_score ] );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'ranking_score' => 90.0, 'rating_avg' => 3.0, 'verified' => 0 ], [ 'provider_id' => $high_score ] );

		$controller = new MarketplaceController();
		$request    = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$data       = $controller->browse( $request )->get_data()['data'];

		$ids = array_column( $data, 'id' );
		$this->assertLessThan( array_search( $low_score, $ids, true ), array_search( $high_score, $ids, true ), 'A real, higher ranking_score must place a provider ahead of one with a higher raw rating/verified flag but a lower computed score.' );
	}

	public function test_ranking_reasons_only_include_truthfully_earned_labels(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$wpdb->update(
			$wpdb->prefix . 'bc_provider_index',
			[ 'ranking_signals' => wp_json_encode( [ 'verified', 'high_rating', 'some_unknown_future_key' ] ) ],
			[ 'provider_id' => $provider_id ]
		);

		$controller = new MarketplaceController();
		$request    = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$data       = $controller->browse( $request )->get_data()['data'];

		$row = current( array_filter( $data, static fn ( array $r ) => $r['id'] === $provider_id ) );
		$this->assertContains( 'تأیید شده', $row['rankingReasons'] );
		$this->assertContains( 'امتیاز بالا', $row['rankingReasons'] );
		$this->assertCount( 2, $row['rankingReasons'], 'An unrecognized/unknown signal key must never be surfaced raw to the user -- only known, truthful labels are shown.' );
	}
}
