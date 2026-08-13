<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Tests;

use BeauClick\Referral\ReferralService;
use BeauClick\Referral\Rest\ReferralController;
use WP_REST_Request;
use WP_UnitTestCase;

final class ReferralControllerTest extends WP_UnitTestCase {

	// 1. summary() is self-scoped -- always the CURRENT user's own data,
	// never a client-supplied id (there is no id parameter on this route at all).
	public function test_summary_returns_the_current_users_own_data(): void {
		$user_id = self::factory()->user->create();
		wp_set_current_user( $user_id );

		$data = ( new ReferralController() )->summary()->get_data()['data'];

		$this->assertArrayHasKey( 'code', $data );
		$this->assertArrayHasKey( 'shareUrl', $data );
		$this->assertSame( 0, $data['referredCount'] );
	}

	// 2. the admin route is genuinely admin-only.
	public function test_require_admin_denies_a_plain_customer(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'customer' ] );
		wp_set_current_user( $user_id );

		$result = ( new ReferralController() )->require_admin();

		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_require_admin_allows_a_platform_administrator(): void {
		$user_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $user_id );

		$this->assertTrue( ( new ReferralController() )->require_admin() );
	}

	// 3. admin_list() returns real rows, not a mock.
	public function test_admin_list_returns_real_referral_rows(): void {
		$admin    = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		wp_set_current_user( $admin );

		$code = ( new ReferralService() )->get_or_create_code( $referrer );
		( new ReferralService() )->attribute( $code, $referee );

		$request  = new WP_REST_Request( 'GET', '/beauclick/v1/referrals/admin/list' );
		$response = ( new ReferralController() )->admin_list( $request );
		$items    = $response->get_data()['data'];

		$this->assertCount( 1, $items );
		$this->assertSame( $referrer, $items[0]['referrerUserId'] );
		$this->assertSame( $referee, $items[0]['refereeUserId'] );
		$this->assertSame( 'pending', $items[0]['status'] );
	}
}
