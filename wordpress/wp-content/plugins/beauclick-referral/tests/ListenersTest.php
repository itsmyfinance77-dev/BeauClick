<?php
declare( strict_types=1 );

namespace BeauClick\Referral\Tests;

use BeauClick\Referral\Listeners\AttributionListener;
use BeauClick\Referral\Listeners\QualificationListener;
use BeauClick\Referral\ReferralService;
use WP_UnitTestCase;

final class ListenersTest extends WP_UnitTestCase {

	public function tear_down(): void {
		unset( $_COOKIE['bc_ref'] );
		parent::tear_down();
	}

	// 1. a returning (non-new) account must never be attributed, even with
	// a valid referral cookie present.
	public function test_attribution_listener_ignores_returning_accounts(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$code     = ( new ReferralService() )->get_or_create_code( $referrer );
		$_COOKIE['bc_ref'] = $code;

		$user = self::factory()->user->create();
		( new AttributionListener() )->on_account_registered( $user, false );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $user ) );
		$this->assertSame( 0, $count );
	}

	// 2. a genuinely new account with a valid cookie gets attributed.
	public function test_attribution_listener_attributes_new_account_from_cookie(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$code     = ( new ReferralService() )->get_or_create_code( $referrer );
		$_COOKIE['bc_ref'] = $code;

		$referee = self::factory()->user->create();
		( new AttributionListener() )->on_account_registered( $referee, true );

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT referrer_user_id FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $referee ), ARRAY_A );
		$this->assertSame( (string) $referrer, $row['referrer_user_id'] );
	}

	// 3. no cookie at all is a safe no-op, not an error.
	public function test_attribution_listener_noop_without_cookie(): void {
		unset( $_COOKIE['bc_ref'] );
		$referee = self::factory()->user->create();
		( new AttributionListener() )->on_account_registered( $referee, true );
		$this->assertTrue( true );
	}

	private function insert_completed_booking( int $customer_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id'  => $customer_id,
				'provider_id'  => 1,
				'service_id'   => 1,
				'slot_id'      => 1,
				'slot_start'   => current_time( 'mysql' ),
				'slot_end'     => current_time( 'mysql' ),
				'status'       => 'completed',
				'payment_status' => 'paid',
				'created_at'   => current_time( 'mysql' ),
				'updated_at'   => current_time( 'mysql' ),
				'expires_at'   => current_time( 'mysql' ),
			]
		);
		return (int) $wpdb->insert_id;
	}

	// 4. beauclick/booking/completed qualifies (and rewards) the referee's
	// pending referral -- the "first completed booking" qualifying path.
	public function test_qualification_listener_on_booking_completed(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		$service  = new ReferralService();
		$code     = $service->get_or_create_code( $referrer );
		$service->attribute( $code, $referee );

		$booking_id = $this->insert_completed_booking( $referee );
		( new QualificationListener() )->on_booking_completed( $booking_id );

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $referee ), ARRAY_A );
		$this->assertSame( 'rewarded', $row['status'] );
	}

	// 5. beauclick/payments/shop_order_completed qualifies too -- the
	// "first completed shop/B2B order" qualifying path.
	public function test_qualification_listener_on_shop_order_completed(): void {
		global $wpdb;
		$referrer = self::factory()->user->create();
		$referee  = self::factory()->user->create();
		$service  = new ReferralService();
		$code     = $service->get_or_create_code( $referrer );
		$service->attribute( $code, $referee );

		( new QualificationListener() )->on_shop_order_completed( 9999, $referee );

		$row = $wpdb->get_row( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_referrals WHERE referee_user_id = %d", $referee ), ARRAY_A );
		$this->assertSame( 'rewarded', $row['status'] );
	}

	// 6. a guest checkout (customer_id = 0) has no account to qualify -- must not error.
	public function test_qualification_listener_ignores_guest_checkout(): void {
		( new QualificationListener() )->on_shop_order_completed( 9999, 0 );
		$this->assertTrue( true );
	}
}
