<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\JourneySummaryService;
use BeauClick\Journey\Profile\BeautyProfileService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class JourneySummaryServiceTest extends WP_UnitTestCase {

	private function make_provider( string $name = 'سالن تست' ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_title' => $name ] );
	}

	private function make_slot( int $provider_id, string $start ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => $start, 'end_at' => $start, 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	public function test_summary_includes_the_customers_own_profile_and_active_goals(): void {
		$user_id = self::factory()->user->create();
		( new BeautyProfileService() )->update( $user_id, [ 'preferredCityId' => 37 ] );
		( new GoalService() )->create( $user_id, 'هدف تست', null, null, null, null );

		$summary = ( new JourneySummaryService() )->for_user( $user_id );

		$this->assertSame( 37, $summary['profile']['preferredCityId'] );
		$this->assertCount( 1, $summary['activeGoals'] );
	}

	public function test_summary_includes_a_future_confirmed_booking_as_upcoming(): void {
		$provider_id = $this->make_provider();
		$user_id     = self::factory()->user->create();
		$future      = gmdate( 'Y-m-d H:i:s', time() + 10 * DAY_IN_SECONDS );
		$slot_id     = $this->make_slot( $provider_id, $future );

		$service    = new BookingService();
		$booking_id = $service->create_booking( $user_id, $provider_id, $slot_id )['booking_id'];
		$service->confirm_booking( $booking_id );

		$summary = ( new JourneySummaryService() )->for_user( $user_id );

		$this->assertCount( 1, $summary['upcomingBookings'] );
		$this->assertSame( 'سالن تست', $summary['upcomingBookings'][0]['providerName'] );
	}

	public function test_a_pending_unconfirmed_booking_is_not_shown_as_upcoming(): void {
		$provider_id = $this->make_provider();
		$user_id     = self::factory()->user->create();
		$future      = gmdate( 'Y-m-d H:i:s', time() + 10 * DAY_IN_SECONDS );
		$slot_id     = $this->make_slot( $provider_id, $future );

		( new BookingService() )->create_booking( $user_id, $provider_id, $slot_id );

		$summary = ( new JourneySummaryService() )->for_user( $user_id );

		$this->assertSame( [], $summary['upcomingBookings'], 'A booking still pending confirmation must not appear as an upcoming appointment.' );
	}

	public function test_summary_includes_the_real_loyalty_balance(): void {
		$user_id = self::factory()->user->create();
		if ( class_exists( \BeauClick\Loyalty\LoyaltyLedger::class ) ) {
			( new \BeauClick\Loyalty\LoyaltyLedger() )->award( $user_id, 15, 'test_reason' );
		}

		$summary = ( new JourneySummaryService() )->for_user( $user_id );

		$this->assertSame( 15, $summary['loyaltyBalance'] );
	}

	public function test_summary_never_leaks_another_users_data(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		( new GoalService() )->create( $user_a, 'هدف محرمانه الف', null, null, null, null );

		$summary_b = ( new JourneySummaryService() )->for_user( $user_b );

		$this->assertSame( [], $summary_b['activeGoals'] );
	}

	public function test_a_brand_new_user_gets_an_empty_but_valid_summary(): void {
		$user_id = self::factory()->user->create();
		$summary = ( new JourneySummaryService() )->for_user( $user_id );

		$this->assertSame( [], $summary['activeGoals'] );
		$this->assertSame( [], $summary['upcomingBookings'] );
		$this->assertSame( [], $summary['recentCompletedServices'] );
		$this->assertSame( [], $summary['recentRecommendations'] );
	}
}
