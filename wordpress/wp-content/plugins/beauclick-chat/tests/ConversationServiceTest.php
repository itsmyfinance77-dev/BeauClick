<?php
declare( strict_types=1 );

namespace BeauClick\Chat\Tests;

use BeauClick\Chat\Chat\ConversationService;
use WP_UnitTestCase;

final class ConversationServiceTest extends WP_UnitTestCase {

	public function test_starting_a_conversation_twice_returns_the_same_conversation(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();

		$service = new ConversationService();
		$first   = $service->start_or_get( $customer, $pro );
		$second  = $service->start_or_get( $customer, $pro );

		$this->assertSame( $first['id'], $second['id'] );
	}

	/**
	 * The pair is stored in canonical (smaller id, larger id) order — this
	 * asserts that starting it from the OTHER direction (the professional
	 * messaging first) still finds the same row, not a duplicate.
	 */
	public function test_the_conversation_is_found_regardless_of_who_initiates(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();

		$service   = new ConversationService();
		$as_customer = $service->start_or_get( $customer, $pro );
		$as_pro      = $service->start_or_get( $pro, $customer );

		$this->assertSame( $as_customer['id'], $as_pro['id'] );
	}

	public function test_a_user_cannot_start_a_conversation_with_themselves(): void {
		$user_id = self::factory()->user->create();
		$service = new ConversationService();

		$this->assertNull( $service->start_or_get( $user_id, $user_id ) );
	}

	public function test_sending_a_message_updates_last_message_at_and_fires_the_hook(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$this->assertNull( $conversation['lastMessageAt'] );

		$fired = false;
		add_action( 'beauclick/chat/message_sent', function () use ( &$fired ) { $fired = true; } );

		$message = $service->send_message( $conversation['id'], $customer, 'سلام، وقت دارید؟' );

		$this->assertIsArray( $message );
		$this->assertSame( 'سلام، وقت دارید؟', $message['body'] );
		$this->assertTrue( $fired, 'send_message() must fire beauclick/chat/message_sent — the seam a future realtime layer subscribes to.' );

		$refreshed = $service->find( $conversation['id'] );
		$this->assertNotNull( $refreshed['lastMessageAt'] );
	}

	/**
	 * V2.0 Step 1: send_message() already logged this event before this
	 * task started (see EventLogger) -- this closes the gap that nothing
	 * previously asserted the wp_bc_events row itself, only the separate
	 * beauclick/chat/message_sent action hook above.
	 */
	public function test_sending_a_message_writes_a_message_sent_event(): void {
		global $wpdb;
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$service->send_message( $conversation['id'], $customer, 'سلام' );

		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$wpdb->prefix}bc_events WHERE event_type = %s AND entity_type = 'conversation' AND entity_id = %d",
				'message_sent',
				$conversation['id']
			),
			ARRAY_A
		);
		$this->assertNotNull( $row, 'A real wp_bc_events row must exist for message_sent, not just the action hook.' );
		$this->assertSame( (string) $customer, $row['actor_id'] );
	}

	public function test_sending_a_blank_message_is_rejected_without_side_effects(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$result = $service->send_message( $conversation['id'], $customer, '   ' );

		$this->assertNull( $result );
		$this->assertCount( 0, $service->messages( $conversation['id'] ) );
	}

	public function test_unread_count_only_counts_the_other_participants_messages(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$service->send_message( $conversation['id'], $customer, 'سلام' );
		$service->send_message( $conversation['id'], $customer, 'اونجایید؟' );

		$this->assertSame( 2, $service->unread_count( $conversation['id'], $pro ), "The professional has 2 unread messages from the customer." );
		$this->assertSame( 0, $service->unread_count( $conversation['id'], $customer ), "A user's own sent messages must never count as unread for themselves." );
	}

	public function test_marking_read_clears_unread_count_for_that_reader_only(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$service->send_message( $conversation['id'], $customer, 'سلام' );
		$service->mark_read( $conversation['id'], $pro );

		$this->assertSame( 0, $service->unread_count( $conversation['id'], $pro ) );
	}

	/**
	 * A production-readiness audit found list_for_user() unbounded — this
	 * asserts the limit/offset added to fix it actually page correctly.
	 */
	public function test_list_for_user_is_paginated(): void {
		$user = self::factory()->user->create();
		$service = new ConversationService();

		for ( $i = 0; $i < 3; $i++ ) {
			$other = self::factory()->user->create();
			$service->start_or_get( $user, $other );
		}

		$this->assertCount( 3, $service->list_for_user( $user, 50, 0 ) );
		$this->assertCount( 2, $service->list_for_user( $user, 2, 0 ) );
		$this->assertCount( 1, $service->list_for_user( $user, 2, 2 ) );
		$this->assertSame( 3, $service->count_for_user( $user ) );
	}

	/**
	 * last_messages_for()/unread_counts_for() replaced a per-conversation
	 * query loop (N+1) with one batch query each — this asserts the batch
	 * queries still attribute each result to the right conversation.
	 */
	public function test_batch_last_messages_and_unread_counts_are_keyed_by_conversation(): void {
		$customer = self::factory()->user->create();
		$pro_a    = self::factory()->user->create();
		$pro_b    = self::factory()->user->create();
		$service  = new ConversationService();

		$conv_a = $service->start_or_get( $customer, $pro_a );
		$conv_b = $service->start_or_get( $customer, $pro_b );

		$service->send_message( $conv_a['id'], $customer, 'پیام اول به آ' );
		$service->send_message( $conv_a['id'], $pro_a, 'پاسخ آ' );
		$service->send_message( $conv_b['id'], $customer, 'پیام به ب' );

		$ids = [ $conv_a['id'], $conv_b['id'] ];

		$last_messages = $service->last_messages_for( $ids );
		$this->assertSame( 'پاسخ آ', $last_messages[ $conv_a['id'] ], 'Must return each conversation\'s OWN most recent message, not any conversation\'s.' );
		$this->assertSame( 'پیام به ب', $last_messages[ $conv_b['id'] ] );

		$unread = $service->unread_counts_for( $ids, $customer );
		$this->assertSame( 1, $unread[ $conv_a['id'] ], 'Customer has 1 unread from the professional in conversation A.' );
		$this->assertArrayNotHasKey( $conv_b['id'], $unread, 'A conversation with nothing unread for this user must be absent, not zero-filled, from the batch result.' );
	}

	public function test_rate_limit_blocks_a_burst_of_messages_beyond_the_cap(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		for ( $i = 0; $i < 20; $i++ ) {
			$result = $service->send_message( $conversation['id'], $customer, "پیام {$i}" );
			$this->assertIsArray( $result, "Message {$i} should still be within the rate limit." );
		}

		$blocked = $service->send_message( $conversation['id'], $customer, 'پیام ۲۱' );
		$this->assertFalse( $blocked, 'A 21st message within the window must be rate-limited, not silently accepted.' );
	}

	// V2.2 Step 14 — data export must only contain the requesting user's own words, never the counterpart's.
	public function test_export_for_user_returns_only_their_own_messages(): void {
		$customer = self::factory()->user->create();
		$pro      = self::factory()->user->create();
		$service  = new ConversationService();
		$conversation = $service->start_or_get( $customer, $pro );

		$service->send_message( $conversation['id'], $customer, 'سلام، وقت دارید؟' );
		$service->send_message( $conversation['id'], $pro, 'بله، چه ساعتی مناسب است؟' );

		$export = $service->export_for_user( $customer );

		$this->assertCount( 1, $export );
		$this->assertSame( 'سلام، وقت دارید؟', $export[0]['body'] );
	}

	public function test_export_for_user_is_empty_when_the_user_has_no_conversations(): void {
		$user_id = self::factory()->user->create();
		$this->assertSame( [], ( new ConversationService() )->export_for_user( $user_id ) );
	}
}
