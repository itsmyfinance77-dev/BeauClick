<?php
declare( strict_types=1 );

namespace BeauClick\Analytics\Tests;

use BeauClick\Analytics\Rest\MyAnalyticsController;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_REST_Request;
use WP_UnitTestCase;

final class MyAnalyticsControllerTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id, string $post_type = Registrar::PROFESSIONAL ): int {
		return self::factory()->post->create( [ 'post_type' => $post_type, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	// 1. Own analytics visible.
	public function test_the_owning_professional_sees_their_own_summary(): void {
		$owner = self::factory()->user->create();
		$this->make_provider( $owner );
		wp_set_current_user( $owner );

		$response = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );

		$this->assertSame( 200, $response->get_status() );
		$this->assertArrayHasKey( 'funnel', $response->get_data()['data']['metrics'] );
	}

	public function test_a_user_with_no_provider_profile_gets_a_real_404_not_zeroed_data(): void {
		$user = self::factory()->user->create();
		wp_set_current_user( $user );

		$response = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );

		$this->assertSame( 404, $response->get_status() );
	}

	// 2. Another professional's analytics blocked (never a client-supplied provider id exists on this route at all).
	public function test_analytics_are_never_scoped_by_a_request_supplied_provider_id(): void {
		$owner_a = self::factory()->user->create();
		$owner_b = self::factory()->user->create();
		$provider_a = $this->make_provider( $owner_a );
		$provider_b = $this->make_provider( $owner_b );

		wp_set_current_user( $owner_a );
		$request = new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' );
		$request->set_param( 'provider_id', $provider_b ); // Even if a caller tries to smuggle one in.

		$response = ( new MyAnalyticsController() )->summary( $request );

		$this->assertSame( $provider_a, $response->get_data()['data']['providerId'], 'The route must always resolve the provider from the caller\'s own session, never a request parameter.' );
	}

	// 6. No private customer data leakage -- the summary payload is aggregate-only.
	public function test_the_summary_payload_never_includes_raw_customer_identities(): void {
		$owner = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer = self::factory()->user->create( [ 'user_email' => 'private-customer@example.test' ] );

		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[ 'customer_id' => $customer, 'provider_id' => $provider_id, 'slot_id' => 0, 'slot_start' => current_time( 'mysql' ), 'slot_end' => current_time( 'mysql' ), 'status' => 'completed', 'created_at' => current_time( 'mysql' ), 'updated_at' => current_time( 'mysql' ) ]
		);

		wp_set_current_user( $owner );
		$response = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );
		$payload  = wp_json_encode( $response->get_data() );

		$this->assertStringNotContainsString( 'private-customer@example.test', (string) $payload );
	}

	// B2B section is additive and honest -- no account, no section.
	public function test_no_b2b_account_means_no_b2b_section(): void {
		$owner = self::factory()->user->create();
		$this->make_provider( $owner );
		wp_set_current_user( $owner );

		$response = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );

		$this->assertNull( $response->get_data()['data']['b2b'] );
	}

	// V2.4 Step 25: the summary response includes a real benchmark section, scoped correctly by the caller's own specialties.
	public function test_summary_includes_a_specialty_scoped_benchmark_section(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$term        = wp_insert_term( 'کاشت ناخن', 'bc_specialty' );
		wp_set_post_terms( $provider_id, [ $term['term_id'] ], 'bc_specialty' );
		wp_set_current_user( $owner );

		$response  = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );
		$benchmark = $response->get_data()['data']['benchmark'];

		$this->assertSame( 'specialty_peers', $benchmark['scope'] );
		$this->assertArrayHasKey( 'peerCount', $benchmark );
		$this->assertArrayHasKey( 'conversionRate', $benchmark );
		$this->assertArrayHasKey( 'avgRating', $benchmark );
	}

	public function test_an_approved_b2b_account_surfaces_a_b2b_section(): void {
		if ( ! class_exists( '\BeauClick\B2B\Business\BusinessAccountService' ) ) {
			$this->markTestSkipped( 'beauclick-b2b not active in this test run.' );
		}

		$owner = self::factory()->user->create();
		$this->make_provider( $owner );
		$account_id = ( new \BeauClick\B2B\Business\BusinessAccountService() )->apply( $owner, 'کسب‌وکار تست' );
		( new \BeauClick\B2B\Business\BusinessAccountService() )->approve( $account_id );

		wp_set_current_user( $owner );
		$response = ( new MyAnalyticsController() )->summary( new WP_REST_Request( 'GET', '/beauclick/v1/analytics/my/summary' ) );
		$b2b      = $response->get_data()['data']['b2b'];

		$this->assertNotNull( $b2b );
		$this->assertSame( 'approved', $b2b['accountStatus'] );
	}
}
