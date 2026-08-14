<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Availability\AvailabilityService;
use WP_UnitTestCase;

final class AvailabilityServiceTest extends WP_UnitTestCase {

	private function far_future( int $hours = 240 ): string {
		return gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + $hours * HOUR_IN_SECONDS );
	}

	public function test_a_professional_can_create_a_real_open_slot(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );

		$result = ( new AvailabilityService() )->create_slot( $provider_id, $start, $end, null );

		$this->assertIsArray( $result );
		$status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $result['id'] ) );
		$this->assertSame( 'open', $status );
	}

	public function test_a_slot_ending_before_it_starts_is_rejected(): void {
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();

		$result = ( new AvailabilityService() )->create_slot( $provider_id, $start, $start, null );

		$this->assertSame( AvailabilityService::ERROR_INVALID_RANGE, $result );
	}

	public function test_a_slot_in_the_past_is_rejected(): void {
		$provider_id = self::factory()->user->create();
		$start       = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) - HOUR_IN_SECONDS );
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );

		$result = ( new AvailabilityService() )->create_slot( $provider_id, $start, $end, null );

		$this->assertSame( AvailabilityService::ERROR_IN_PAST, $result );
	}

	public function test_an_overlapping_slot_is_rejected(): void {
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );

		$service = new AvailabilityService();
		$service->create_slot( $provider_id, $start, $end, null );

		$overlap_start = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + 30 * MINUTE_IN_SECONDS );
		$overlap_end   = gmdate( 'Y-m-d H:i:s', strtotime( $overlap_start ) + HOUR_IN_SECONDS );
		$result        = $service->create_slot( $provider_id, $overlap_start, $overlap_end, null );

		$this->assertSame( AvailabilityService::ERROR_OVERLAPS, $result );
	}

	public function test_a_non_overlapping_back_to_back_slot_is_allowed(): void {
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );

		$service = new AvailabilityService();
		$service->create_slot( $provider_id, $start, $end, null );
		$result = $service->create_slot( $provider_id, $end, gmdate( 'Y-m-d H:i:s', strtotime( $end ) + HOUR_IN_SECONDS ), null );

		$this->assertIsArray( $result, 'A slot starting exactly when the previous one ends must not be treated as an overlap.' );
	}

	public function test_only_an_open_slot_can_be_deleted(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );
		$service     = new AvailabilityService();
		$created     = $service->create_slot( $provider_id, $start, $end, null );

		$wpdb->update( $wpdb->prefix . 'bc_availability_slots', [ 'status' => 'booked' ], [ 'id' => $created['id'] ] );

		$this->assertFalse( $service->delete_slot( $provider_id, $created['id'] ), 'A booked slot must never be silently deletable -- it backs a real, in-flight booking.' );
	}

	public function test_a_provider_cannot_delete_another_providers_open_slot(): void {
		$provider_a = self::factory()->user->create();
		$provider_b = self::factory()->user->create();
		$start      = $this->far_future();
		$end        = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );
		$service    = new AvailabilityService();
		$created    = $service->create_slot( $provider_a, $start, $end, null );

		$this->assertFalse( $service->delete_slot( $provider_b, $created['id'] ) );
	}

	public function test_deleting_an_open_slot_removes_it(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$start       = $this->far_future();
		$end         = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );
		$service     = new AvailabilityService();
		$created     = $service->create_slot( $provider_id, $start, $end, null );

		$deleted = $service->delete_slot( $provider_id, $created['id'] );

		$this->assertTrue( $deleted );
		$this->assertNull( $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $created['id'] ) ) );
	}

	public function test_list_own_only_returns_this_providers_future_slots(): void {
		$provider_a = self::factory()->user->create();
		$provider_b = self::factory()->user->create();
		$start      = $this->far_future();
		$end        = gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS );
		$service    = new AvailabilityService();
		$service->create_slot( $provider_a, $start, $end, null );
		$service->create_slot( $provider_b, $start, $end, null );

		$list = $service->list_own( $provider_a );

		$this->assertCount( 1, $list );
	}

	// --- bulk_generate ---

	public function test_bulk_generate_creates_slots_for_the_matching_weekdays_only(): void {
		$provider_id = self::factory()->user->create();
		$date_from       = gmdate( 'Y-m-d', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS );
		$date_to         = gmdate( 'Y-m-d', strtotime( $date_from ) + 6 * DAY_IN_SECONDS ); // A full 7-day span.
		$only_weekday    = (int) gmdate( 'w', strtotime( $date_from ) ); // Exactly one day in a 7-day span matches a single weekday.

		// Only one weekday selected, 4 one-hour slots per matching day (10:00-14:00) -- exactly 4 created.
		$result = ( new AvailabilityService() )->bulk_generate( $provider_id, [ $only_weekday ], '10:00', '14:00', 60, $date_from, $date_to, null );

		$this->assertIsArray( $result );
		$this->assertSame( 4, $result['created'], 'Only the one matching weekday in the 7-day span should have produced slots.' );
		$this->assertSame( 0, $result['skipped'] );
	}

	public function test_bulk_generate_is_idempotent_on_a_second_run(): void {
		$provider_id = self::factory()->user->create();
		$date_from   = gmdate( 'Y-m-d', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS );
		$date_to     = $date_from;

		$service = new AvailabilityService();
		$first   = $service->bulk_generate( $provider_id, [ 0, 1, 2, 3, 4, 5, 6 ], '10:00', '12:00', 60, $date_from, $date_to, null );
		$second  = $service->bulk_generate( $provider_id, [ 0, 1, 2, 3, 4, 5, 6 ], '10:00', '12:00', 60, $date_from, $date_to, null );

		$this->assertSame( 2, $first['created'] );
		$this->assertSame( 0, $second['created'], 'Re-running the exact same weekly pattern must never create duplicate slots.' );
		$this->assertSame( 2, $second['skipped'] );
	}

	public function test_bulk_generate_rejects_a_range_beyond_the_bounded_maximum(): void {
		$provider_id = self::factory()->user->create();
		$date_from   = gmdate( 'Y-m-d', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS );
		$date_to     = gmdate( 'Y-m-d', strtotime( $date_from ) + 90 * DAY_IN_SECONDS );

		$result = ( new AvailabilityService() )->bulk_generate( $provider_id, [ 0 ], '10:00', '12:00', 60, $date_from, $date_to, null );

		$this->assertSame( AvailabilityService::ERROR_INVALID_RANGE, $result, 'An adversarial/mistyped huge range must be rejected, never silently generate an unbounded number of rows.' );
	}

	public function test_bulk_generate_rejects_an_invalid_slot_duration(): void {
		$provider_id = self::factory()->user->create();
		$date_from   = gmdate( 'Y-m-d', strtotime( current_time( 'mysql' ) ) + 10 * DAY_IN_SECONDS );

		$result = ( new AvailabilityService() )->bulk_generate( $provider_id, [ 0 ], '10:00', '12:00', 0, $date_from, $date_from, null );

		$this->assertSame( AvailabilityService::ERROR_INVALID_RANGE, $result );
	}
}
