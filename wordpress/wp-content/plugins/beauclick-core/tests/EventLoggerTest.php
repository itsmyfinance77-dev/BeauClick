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
}
