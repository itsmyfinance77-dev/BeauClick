<?php
declare( strict_types=1 );

namespace BeauClick\Journey\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Timeline\TimelineComposer;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class TimelineComposerTest extends WP_UnitTestCase {

	private function make_provider(): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
	}

	private function make_open_slot( int $provider_id ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[ 'provider_id' => $provider_id, 'start_at' => current_time( 'mysql' ), 'end_at' => current_time( 'mysql' ), 'status' => 'open', 'created_at' => current_time( 'mysql' ) ]
		);
		return $wpdb->insert_id;
	}

	public function test_a_created_goal_appears_in_the_timeline(): void {
		$user_id = self::factory()->user->create();
		( new GoalService() )->create( $user_id, 'هدف تست', null, null, null, null );

		$timeline = ( new TimelineComposer() )->for_user( $user_id );

		$types = array_column( $timeline, 'type' );
		$this->assertContains( 'goal_created', $types );
	}

	/**
	 * booking_created/_confirmed/_completed events log with entity_type=
	 * 'booking' and NO actor_id at all (see BookingService::transition()) --
	 * this is the exact gap TimelineComposer's own docblock documents
	 * resolving by matching against the customer's own booking ids instead.
	 */
	public function test_booking_lifecycle_events_appear_in_the_owning_customers_timeline(): void {
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		$service    = new BookingService();
		$booking_id = $service->create_booking( $customer_id, $provider_id, $slot_id )['booking_id'];
		$service->confirm_booking( $booking_id );
		$service->complete_booking( $booking_id );

		$timeline = ( new TimelineComposer() )->for_user( $customer_id );
		$types    = array_column( $timeline, 'type' );

		$this->assertContains( 'booking_created', $types );
		$this->assertContains( 'booking_confirmed', $types );
		$this->assertContains( 'booking_completed', $types );
	}

	public function test_another_customers_booking_events_never_appear(): void {
		$provider_id = $this->make_provider();
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$slot_id     = $this->make_open_slot( $provider_id );

		( new BookingService() )->create_booking( $customer_a, $provider_id, $slot_id );

		$timeline_b = ( new TimelineComposer() )->for_user( $customer_b );

		$this->assertSame( [], $timeline_b, "Customer B's timeline must never include customer A's booking events." );
	}

	public function test_a_user_with_no_activity_gets_an_empty_timeline_not_an_error(): void {
		$user_id  = self::factory()->user->create();
		$timeline = ( new TimelineComposer() )->for_user( $user_id );

		$this->assertSame( [], $timeline );
	}

	public function test_irrelevant_event_types_are_excluded_from_the_timeline(): void {
		$user_id = self::factory()->user->create();
		beauclick_core()->events()->log( 'profile_view', 'bc_professional', 1, $user_id );
		beauclick_core()->events()->log( 'ai_recommendation_shown', 'provider', 1, $user_id );

		$timeline = ( new TimelineComposer() )->for_user( $user_id );

		$this->assertSame( [], $timeline, 'profile_view and ai_recommendation_shown are deliberately excluded as timeline noise.' );
	}

	public function test_timeline_is_ordered_most_recent_first(): void {
		$user_id = self::factory()->user->create();
		$goals   = new GoalService();
		$goals->create( $user_id, 'اول', null, null, null, null );
		sleep( 1 );
		$goals->create( $user_id, 'دوم', null, null, null, null );

		$timeline = ( new TimelineComposer() )->for_user( $user_id );

		$this->assertGreaterThanOrEqual( strtotime( $timeline[1]['createdAt'] ), strtotime( $timeline[0]['createdAt'] ) );
	}

	public function test_pagination_limit_and_offset_are_respected(): void {
		$user_id = self::factory()->user->create();
		$goals   = new GoalService();
		for ( $i = 0; $i < 5; $i++ ) {
			$goals->create( $user_id, "هدف {$i}", null, null, null, null );
		}

		$first_page  = ( new TimelineComposer() )->for_user( $user_id, 2, 0 );
		$second_page = ( new TimelineComposer() )->for_user( $user_id, 2, 2 );

		$this->assertCount( 2, $first_page );
		$this->assertCount( 2, $second_page );
		$this->assertNotSame( $first_page[0]['entityId'], $second_page[0]['entityId'] );
	}
}
