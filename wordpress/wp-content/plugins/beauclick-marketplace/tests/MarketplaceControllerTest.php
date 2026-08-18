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

	/** V2.3 Step 20 (MKT-02): `q` matches a provider's name. */
	public function test_browse_q_matches_provider_name(): void {
		$owner_id = self::factory()->user->create();
		$match    = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'سالن زیبایی مریم' ] );
		$no_match = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'آرایشگاه رضا' ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'مریم' );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $match, $ids );
		$this->assertNotContains( $no_match, $ids );
	}

	/** V2.3 Step 20 (MKT-02): `q` also matches the provider's bio (post_content), not only the name. */
	public function test_browse_q_matches_provider_bio(): void {
		$owner_id = self::factory()->user->create();
		$match    = self::factory()->post->create(
			[
				'post_type'    => Registrar::PROFESSIONAL,
				'post_status'  => 'publish',
				'post_author'  => $owner_id,
				'post_title'   => 'متخصص شماره یک',
				'post_content' => 'متخصص کاشت ناخن با ۱۵ سال سابقه',
			]
		);
		$no_match = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'متخصص شماره دو' ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'کاشت ناخن' );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $match, $ids );
		$this->assertNotContains( $no_match, $ids );
	}

	/** V2.3 Step 20 (MKT-02): a query typed in ASCII digits must still match content stored with Persian digits, and vice versa. */
	public function test_browse_q_matches_regardless_of_digit_system(): void {
		$owner_id = self::factory()->user->create();
		$provider_id = self::factory()->post->create(
			[
				'post_type'    => Registrar::PROFESSIONAL,
				'post_status'  => 'publish',
				'post_author'  => $owner_id,
				'post_title'   => 'سالن تست اعداد',
				'post_content' => '۲۰ سال تجربه',
			]
		);

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', '20 سال' );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $provider_id, $ids );
	}

	/** V2.3 Step 20: an empty/whitespace `q` must not filter anything (identical to omitting it). */
	public function test_browse_with_blank_q_returns_all_providers(): void {
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', '   ' );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $provider_id, $ids );
	}

	/** V2.3 Step 20: `q` composes with the existing structured filters (AND, not OR). */
	public function test_browse_q_combines_with_other_filters(): void {
		global $wpdb;
		$owner_id = self::factory()->user->create();
		$right_city_right_name = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'سالن هدف' ] );
		$wrong_city_right_name = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'سالن هدف' ] );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'city_id' => 5 ], [ 'provider_id' => $right_city_right_name ] );
		$wpdb->update( $wpdb->prefix . 'bc_provider_index', [ 'city_id' => 9 ], [ 'provider_id' => $wrong_city_right_name ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'هدف' );
		$request->set_param( 'city_id', 5 );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $right_city_right_name, $ids );
		$this->assertNotContains( $wrong_city_right_name, $ids, 'q must AND with city_id, not OR — a name match in the wrong city must still be excluded.' );
	}

	public function test_specialties_endpoint_returns_real_taxonomy_terms(): void {
		$term = wp_insert_term( 'میکاپ تست', 'bc_specialty' );

		$response = ( new MarketplaceController() )->specialties();
		$names    = array_column( $response->get_data()['data'], 'name' );

		$this->assertContains( 'میکاپ تست', $names );
	}

	/** V2.4 Step 21: a known common typo, matched through the full REST path via SqlSearchProvider. */
	public function test_browse_q_matches_via_a_known_common_typo(): void {
		$owner_id = self::factory()->user->create();
		$match    = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_content' => 'کاشت ناخن با کیفیت' ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'کاشت ناحن' );
		$ids = array_column( ( new MarketplaceController() )->browse( $request )->get_data()['data'], 'id' );

		$this->assertContains( $match, $ids );
	}

	/** V2.4 Step 21: the search_performed event now carries matchedResultCount/zeroResult/searchSource. */
	public function test_browse_writes_the_new_search_event_fields(): void {
		global $wpdb;
		$owner_id = self::factory()->user->create();
		self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id, 'post_title' => 'سالن زیبایی مریم' ] );

		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'مریم' );
		( new MarketplaceController() )->browse( $request );

		$meta = $wpdb->get_var( "SELECT meta FROM {$wpdb->prefix}bc_events WHERE event_type = 'search_performed' ORDER BY id DESC LIMIT 1" );
		$meta = json_decode( (string) $meta, true );

		$this->assertSame( 1, $meta['matchedResultCount'] );
		$this->assertFalse( $meta['zeroResult'] );
		$this->assertSame( 'rest_api', $meta['searchSource'] );
		$this->assertArrayNotHasKey( 'resultCount', $meta, 'The old field name must not linger alongside the new one.' );
	}

	/** V2.4 Step 21: a genuinely no-match query must report zeroResult=true. */
	public function test_browse_with_no_matches_reports_zero_result_true(): void {
		global $wpdb;
		$request = new \WP_REST_Request( 'GET', '/beauclick/v1/marketplace/providers' );
		$request->set_param( 'q', 'یک عبارت کاملا نامرتبط و بی‌نتیجه' );
		( new MarketplaceController() )->browse( $request );

		$meta = $wpdb->get_var( "SELECT meta FROM {$wpdb->prefix}bc_events WHERE event_type = 'search_performed' ORDER BY id DESC LIMIT 1" );
		$meta = json_decode( (string) $meta, true );

		$this->assertTrue( $meta['zeroResult'] );
	}
}
