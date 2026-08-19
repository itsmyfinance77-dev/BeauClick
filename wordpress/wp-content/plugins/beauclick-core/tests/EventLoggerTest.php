<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Support\EventLogger;
use WP_UnitTestCase;

final class EventLoggerTest extends WP_UnitTestCase {

	public function test_log_writes_a_real_row_with_the_given_shape(): void {
		global $wpdb;
		$logger = new EventLogger();

		$logger->log( 'profile_view', 'bc_professional', 42, 7, [ 'foo' => 'bar' ] );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_id = %d", 'profile_view', 42 ),
			ARRAY_A
		);

		$this->assertNotNull( $row );
		$this->assertSame( 'bc_professional', $row['entity_type'] );
		$this->assertSame( '7', $row['actor_id'] );
		$this->assertSame( [ 'foo' => 'bar' ], json_decode( $row['meta'], true ) );
	}

	public function test_has_logged_is_false_before_and_true_after(): void {
		$logger = new EventLogger();

		$this->assertFalse( $logger->has_logged( 'order_completed', 'order', 99 ) );

		$logger->log( 'order_completed', 'order', 99 );

		$this->assertTrue( $logger->has_logged( 'order_completed', 'order', 99 ) );
	}

	public function test_has_logged_is_scoped_to_the_exact_event_type_and_entity(): void {
		$logger = new EventLogger();
		$logger->log( 'order_completed', 'order', 1 );

		$this->assertFalse( $logger->has_logged( 'order_refunded', 'order', 1 ), 'A different event_type for the same entity must not read as already logged.' );
		$this->assertFalse( $logger->has_logged( 'order_completed', 'order', 2 ), 'A different entity_id must not read as already logged.' );
	}

	// V2.4 Step 25: every real EVENT_TYPES constant is accepted silently -- the registry must never falsely flag its own known values.
	public function test_every_registered_event_type_constant_is_accepted_without_a_doing_it_wrong_notice(): void {
		$logger    = new EventLogger();
		$constants = ( new \ReflectionClass( EventLogger::class ) )->getConstants();
		$this->assertNotEmpty( $constants, 'Sanity check on the premise: the registry must not be accidentally empty.' );

		foreach ( $constants as $event_type ) {
			// A PHPUnit "doing it wrong" notice is itself a failed assertion
			// under this project's test scaffolding (confirmed by the real
			// failures this exact mechanism caught during development) --
			// so simply calling log() for every real constant, with no
			// try/catch, is itself the assertion: this test method
			// completing without a converted-notice failure IS the proof.
			$logger->log( $event_type, 'test_entity', 1 );
		}

		$this->assertTrue( true, 'Reached the end without any registered event_type triggering a doing_it_wrong notice.' );
	}

	/**
	 * V2.4 Step 25: an unregistered event_type must surface a real,
	 * WP_DEBUG-gated doing_it_wrong() notice -- the actual mechanism that
	 * caught two real gaps (membership_activated, crm_opened and its three
	 * siblings) during this step's own development, proven here rather than
	 * only asserted in a docblock. setExpectedIncorrectUsage() is WordPress
	 * core's own test-scaffolding hook for this exact assertion shape.
	 */
	public function test_an_unregistered_event_type_triggers_a_doing_it_wrong_notice(): void {
		$this->setExpectedIncorrectUsage( EventLogger::class . '::log' );

		( new EventLogger() )->log( 'totally_made_up_event_type_for_this_test', 'test_entity', 1 );
	}

	// The notice must never stop the event from actually being recorded -- a soft developer signal, never a dropped write.
	public function test_an_unregistered_event_type_is_still_written_to_the_table(): void {
		global $wpdb;
		$this->setExpectedIncorrectUsage( EventLogger::class . '::log' );

		( new EventLogger() )->log( 'another_made_up_event_type', 'test_entity', 55 );

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_id = %d", 'another_made_up_event_type', 55 ),
			ARRAY_A
		);
		$this->assertNotNull( $row, 'An unregistered event_type must still be written -- the notice is a developer signal, not a validation rejection.' );
	}
}
