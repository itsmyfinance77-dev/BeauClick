<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Booking\BookingService;
use BeauClick\Booking\Booking\RescheduleService;
use BeauClick\Booking\Reminders\ReminderScheduler;
use WP_UnitTestCase;

final class RescheduleServiceTest extends WP_UnitTestCase {

	private function make_slot( int $provider_id, string $start, ?int $service_id = null, string $status = 'open' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_availability_slots',
			[
				'provider_id' => $provider_id,
				'service_id'  => $service_id,
				'start_at'    => $start,
				'end_at'      => gmdate( 'Y-m-d H:i:s', strtotime( $start ) + HOUR_IN_SECONDS ),
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	private function far_future( int $days = 10 ): string {
		return gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + $days * DAY_IN_SECONDS );
	}

	// --- Eligibility ---------------------------------------------------

	public function test_the_owning_customer_can_reschedule_an_eligible_confirmed_booking(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		$this->assertIsArray( $result, 'An eligible reschedule must succeed.' );
		$this->assertSame( $new_slot, (int) $result['slot_id'] );
		$this->assertSame( BookingService::STATUS_CONFIRMED, $result['status'], 'Rescheduling must not change the booking status.' );
	}

	public function test_a_completed_booking_cannot_be_rescheduled(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );
		$booking_service->complete_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );
		$this->assertSame( 'status', $result );
	}

	public function test_a_cancelled_booking_cannot_be_rescheduled(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->cancel_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );
		$this->assertSame( 'status', $result );
	}

	public function test_a_booking_too_close_to_its_slot_start_cannot_be_rescheduled(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$soon        = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 2 * HOUR_IN_SECONDS ); // Below the 6h default.
		$old_slot    = $this->make_slot( $provider_id, $soon );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future() );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );
		$this->assertSame( 'too_close', $result );
	}

	public function test_reschedule_is_blocked_once_the_max_reschedule_count_is_reached(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot_a      = $this->make_slot( $provider_id, $this->far_future( 10 ) );

		$booking_service   = new BookingService();
		$reschedule_service = new RescheduleService();
		$booking            = $booking_service->create_booking( $customer_id, $provider_id, $slot_a );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$current_slot = $slot_a;
		for ( $i = 0; $i < RescheduleService::DEFAULT_MAX_RESCHEDULES; $i++ ) {
			$next   = $this->make_slot( $provider_id, $this->far_future( 20 + $i ) );
			$result = $reschedule_service->reschedule( $booking['booking_id'], $next, $customer_id );
			$this->assertIsArray( $result, "Reschedule #{$i} should still be within the allowed limit." );
			$current_slot = $next;
		}

		$one_more = $this->make_slot( $provider_id, $this->far_future( 40 ) );
		$result   = $reschedule_service->reschedule( $booking['booking_id'], $one_more, $customer_id );
		$this->assertSame( 'max_reached', $result, 'A booking must be blocked from rescheduling past the configured maximum.' );
	}

	public function test_rescheduling_to_the_same_slot_is_rejected(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$slot        = $this->make_slot( $provider_id, $this->far_future() );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $slot, $customer_id );
		$this->assertSame( 'same_slot', $result );
	}

	public function test_rescheduling_to_a_different_providers_slot_is_rejected(): void {
		$provider_a  = self::factory()->user->create();
		$provider_b  = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_a, $this->far_future() );
		$foreign_slot = $this->make_slot( $provider_b, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_a, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $foreign_slot, $customer_id );
		$this->assertSame( 'invalid_slot', $result, 'Minimum safe scope is same-provider only — a different provider is not a valid reschedule target.' );
	}

	public function test_rescheduling_to_a_different_services_slot_is_rejected(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future(), 501 );
		$other_slot  = $this->make_slot( $provider_id, $this->far_future( 11 ), 502 );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot, 501 );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $other_slot, $customer_id );
		$this->assertSame( 'invalid_slot', $result, 'Minimum safe scope is same-service only — a different service is not a valid reschedule target.' );
	}

	public function test_a_nonexistent_booking_returns_not_found(): void {
		$result = ( new RescheduleService() )->reschedule( 999999, 1, self::factory()->user->create() );
		$this->assertSame( 'not_found', $result );
	}

	// --- Slot safety / concurrency --------------------------------------

	public function test_rescheduling_to_an_already_taken_slot_fails_safely_and_original_booking_stays_valid(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$other_id    = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$target_slot = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		// Someone else claims the target slot first.
		$booking_service->create_booking( $other_id, $provider_id, $target_slot );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $target_slot, $customer_id );
		$this->assertSame( 'slot_unavailable', $result );

		$still_valid = $booking_service->find( $booking['booking_id'] );
		$this->assertSame( $old_slot, (int) $still_valid['slot_id'], 'A failed reschedule must never leave the customer without their original, still-valid booking.' );
		$this->assertSame( BookingService::STATUS_CONFIRMED, $still_valid['status'] );
	}

	public function test_a_held_slot_within_its_hold_window_cannot_be_reschedule_target(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$holder_id   = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$target_slot = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );
		$booking_service->create_booking( $holder_id, $provider_id, $target_slot ); // Still within its 15-minute hold.

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $target_slot, $customer_id );
		$this->assertSame( 'slot_unavailable', $result );
	}

	public function test_concurrent_reschedule_attempts_to_the_same_new_slot_cannot_double_book(): void {
		$provider_id = self::factory()->user->create();
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$slot_a      = $this->make_slot( $provider_id, $this->far_future() );
		$slot_b      = $this->make_slot( $provider_id, $this->far_future( 1 ) );
		$target_slot = $this->make_slot( $provider_id, $this->far_future( 20 ) );

		$booking_service    = new BookingService();
		$reschedule_service = new RescheduleService();
		$booking_a          = $booking_service->create_booking( $customer_a, $provider_id, $slot_a );
		$booking_service->confirm_booking( $booking_a['booking_id'] );
		$booking_b = $booking_service->create_booking( $customer_b, $provider_id, $slot_b );
		$booking_service->confirm_booking( $booking_b['booking_id'] );

		$first  = $reschedule_service->reschedule( $booking_a['booking_id'], $target_slot, $customer_a );
		$second = $reschedule_service->reschedule( $booking_b['booking_id'], $target_slot, $customer_b );

		$this->assertIsArray( $first );
		$this->assertSame( 'slot_unavailable', $second, 'Two bookings must never both be moved onto the same target slot.' );

		global $wpdb;
		$occupants = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_bookings WHERE slot_id = %d AND status IN ('pending','confirmed')", $target_slot )
		);
		$this->assertSame( 1, $occupants, 'Exactly one booking may end up occupying the target slot, never two.' );
	}

	// --- Payment / order integrity --------------------------------------

	public function test_rescheduling_leaves_the_linked_wc_order_id_untouched(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );
		$wpdb->update( $wpdb->prefix . 'bc_bookings', [ 'wc_order_id' => 4242 ], [ 'id' => $booking['booking_id'] ] );

		$result = ( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		$this->assertIsArray( $result );
		$this->assertSame( '4242', (string) $result['wc_order_id'], 'Rescheduling within the same provider/service scope must never create or detach the linked order — no duplicate order.' );
	}

	// --- History / audit --------------------------------------------------

	public function test_reschedule_history_records_who_when_from_and_to(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service    = new BookingService();
		$reschedule_service = new RescheduleService();
		$booking             = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$reschedule_service->reschedule( $booking['booking_id'], $new_slot, $customer_id, 'مشتری زمان دیگری خواست' );

		$history = $reschedule_service->history( $booking['booking_id'] );
		$this->assertCount( 1, $history );
		$this->assertSame( RescheduleService::ACTOR_CUSTOMER, $history[0]['actorRole'] );
		$this->assertSame( 'مشتری زمان دیگری خواست', $history[0]['reason'] );
		$this->assertSame( 1, $reschedule_service->reschedule_count( $booking['booking_id'] ) );
	}

	public function test_the_owning_professional_is_recorded_as_the_actor_when_they_reschedule(): void {
		global $wpdb;
		$owner_id    = self::factory()->user->create();
		$provider_id = self::factory()->post->create( [ 'post_type' => \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service    = new BookingService();
		$reschedule_service = new RescheduleService();
		$booking             = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$reschedule_service->reschedule( $booking['booking_id'], $new_slot, $owner_id );

		$history = $reschedule_service->history( $booking['booking_id'] );
		$this->assertSame( RescheduleService::ACTOR_PROVIDER, $history[0]['actorRole'] );
	}

	// --- Waitlist interaction ---------------------------------------------

	public function test_rescheduling_frees_the_old_slot_and_notifies_a_matching_waitlist_entry(): void {
		global $wpdb;
		// WaitlistService::create() requires a real, published provider CPT
		// post (not merely a user id) -- unlike BookingService, which never
		// validates the provider post itself exists.
		$provider_id = self::factory()->post->create( [ 'post_type' => \BeauClick\Marketplace\PostTypes\Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
		$customer_id = self::factory()->user->create();
		$old_start   = $this->far_future();
		$old_slot    = $this->make_slot( $provider_id, $old_start );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$waiting_customer = self::factory()->user->create();
		( new \BeauClick\Booking\Waitlist\WaitlistService() )->create( $waiting_customer, $provider_id, null, substr( $old_start, 0, 10 ), null, null );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		$slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $old_slot ) );
		$this->assertSame( 'open', $slot_status, 'The old slot must be released back to open.' );

		$notified = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE user_id = %d AND category = 'waitlist'", $waiting_customer )
		);
		$this->assertGreaterThan( 0, $notified, 'Freeing the old slot via reschedule must notify a matching waitlist entry, exactly like a direct cancellation would.' );
	}

	public function test_rescheduling_does_not_duplicate_the_new_slot_as_a_second_waitlist_opening(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		$new_slot_status = $wpdb->get_var( $wpdb->prepare( "SELECT status FROM {$wpdb->prefix}bc_availability_slots WHERE id = %d", $new_slot ) );
		$this->assertSame( 'booked', $new_slot_status, 'The freshly-claimed new slot must never itself be treated as "opened".' );
	}

	// --- Analytics ----------------------------------------------------------

	public function test_successful_reschedule_logs_requested_and_succeeded_events(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		foreach ( [ 'booking_reschedule_requested', 'booking_reschedule_succeeded' ] as $event_type ) {
			$found = $wpdb->get_var(
				$wpdb->prepare( "SELECT id FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_type = 'booking' AND entity_id = %d", $event_type, $booking['booking_id'] )
			);
			$this->assertNotNull( $found, "A wp_bc_events row for {$event_type} must exist." );
		}
	}

	public function test_a_failed_reschedule_logs_a_failed_event_distinguishable_from_success(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );
		$booking_service->complete_booking( $booking['booking_id'] ); // No longer eligible.

		( new RescheduleService() )->reschedule( $booking['booking_id'], $old_slot + 1, $customer_id );

		$failed = $wpdb->get_var(
			$wpdb->prepare( "SELECT meta FROM {$wpdb->prefix}bc_events WHERE event_type = 'booking_reschedule_failed' AND entity_type = 'booking' AND entity_id = %d", $booking['booking_id'] )
		);
		$this->assertNotNull( $failed );
		$this->assertStringContainsString( 'status', (string) $failed );
	}

	// --- Notifications / reminder correction --------------------------------

	public function test_rescheduling_lets_a_new_reminder_fire_after_an_old_one_already_sent(): void {
		global $wpdb;
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create();
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );

		$old_start = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS );
		$old_slot  = $this->make_slot( $provider_id, $old_start );
		$new_start = gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 30 * DAY_IN_SECONDS + 24 * HOUR_IN_SECONDS );
		$new_slot  = $this->make_slot( $provider_id, $new_start );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		// A reminder fires for the OLD appointment time.
		( new ReminderScheduler() )->run();
		$before = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE entity_type = 'booking' AND entity_id = %d AND category = 'reminder'", $booking['booking_id'] )
		);
		$this->assertGreaterThan( 0, $before );

		( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, $customer_id );

		// Move the booking's new slot_start back into the reminder window to simulate time passing, then sweep again.
		$wpdb->update(
			$wpdb->prefix . 'bc_bookings',
			[ 'slot_start' => gmdate( 'Y-m-d H:i:s', strtotime( current_time( 'mysql' ) ) + 24 * HOUR_IN_SECONDS ) ],
			[ 'id' => $booking['booking_id'] ]
		);
		( new ReminderScheduler() )->run();

		$after = (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_notifications WHERE entity_type = 'booking' AND entity_id = %d AND category = 'reminder' AND channel = 'sms'", $booking['booking_id'] )
		);
		$this->assertSame( 1, $after, 'After a reschedule invalidates the stale reminder record, exactly one fresh reminder must be able to fire for the new time -- not zero (suppressed as a false duplicate) and not two.' );
	}

	public function test_reschedule_notifies_the_customer_by_mail(): void {
		$provider_id = self::factory()->user->create();
		$customer_id = self::factory()->user->create( [ 'user_email' => 'customer@example.com' ] );
		$old_slot    = $this->make_slot( $provider_id, $this->far_future() );
		$new_slot    = $this->make_slot( $provider_id, $this->far_future( 11 ) );

		$booking_service = new BookingService();
		$booking          = $booking_service->create_booking( $customer_id, $provider_id, $old_slot );
		$booking_service->confirm_booking( $booking['booking_id'] );

		$sent = [];
		add_filter(
			'wp_mail',
			static function ( array $args ) use ( &$sent ) {
				$sent[] = $args;
				return $args;
			}
		);

		// Admin (actor 0) triggers the reschedule so BOTH parties get mailed, same convention as send_cancelled().
		( new RescheduleService() )->reschedule( $booking['booking_id'], $new_slot, 0 );

		$to_customer = array_filter( $sent, static fn ( array $m ) => $m['to'] === 'customer@example.com' );
		$this->assertNotEmpty( $to_customer, 'The customer must receive a reschedule notification mail.' );
	}
}
