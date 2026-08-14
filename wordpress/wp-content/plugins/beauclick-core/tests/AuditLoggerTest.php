<?php
declare( strict_types=1 );

namespace BeauClick\Core\Tests;

use BeauClick\Core\Support\AuditLogger;
use WP_UnitTestCase;

final class AuditLoggerTest extends WP_UnitTestCase {

	public function test_record_writes_a_row_with_the_given_shape(): void {
		global $wpdb;
		$actor_id = self::factory()->user->create();

		( new AuditLogger() )->record(
			'b2b_account_approved',
			'business_account',
			42,
			$actor_id,
			[ 'approval_status' => 'pending' ],
			[ 'approval_status' => 'approved' ],
			'دلیل نمونه'
		);

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );

		$this->assertSame( 'b2b_account_approved', $row['action_type'] );
		$this->assertSame( 'business_account', $row['entity_type'] );
		$this->assertSame( 42, (int) $row['entity_id'] );
		$this->assertSame( $actor_id, (int) $row['actor_user_id'] );
		$this->assertSame( [ 'approval_status' => 'pending' ], json_decode( $row['previous_state'], true ) );
		$this->assertSame( [ 'approval_status' => 'approved' ], json_decode( $row['new_state'], true ) );
		$this->assertSame( 'دلیل نمونه', $row['reason'] );
	}

	public function test_record_allows_null_previous_and_new_state(): void {
		global $wpdb;

		( new AuditLogger() )->record( 'loyalty_benefit_deleted', 'loyalty_benefit', 7, null, null, null );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );

		$this->assertNull( $row['previous_state'] );
		$this->assertNull( $row['new_state'] );
		$this->assertNull( $row['actor_user_id'] );
	}

	public function test_recent_returns_most_recent_first_and_respects_the_limit(): void {
		$logger = new AuditLogger();
		for ( $i = 1; $i <= 5; $i++ ) {
			$logger->record( 'test_action_' . $i, 'test_entity', $i, null );
		}

		$recent = $logger->recent( 3 );

		$this->assertCount( 3, $recent );
		$this->assertSame( 'test_action_5', $recent[0]['action_type'] );
		$this->assertSame( 'test_action_4', $recent[1]['action_type'] );
		$this->assertSame( 'test_action_3', $recent[2]['action_type'] );
	}

	public function test_query_filters_by_entity_type_and_paginates(): void {
		$logger = new AuditLogger();
		for ( $i = 1; $i <= 3; $i++ ) {
			$logger->record( 'review_moderated', 'review', $i, null );
		}
		$logger->record( 'b2b_account_approved', 'business_account', 1, null );

		$result = $logger->query( [ 'entity_type' => 'review' ], 1, 2 );

		$this->assertSame( 3, $result['total'] );
		$this->assertCount( 2, $result['items'] );
		foreach ( $result['items'] as $item ) {
			$this->assertSame( 'review', $item['entity_type'] );
		}

		$page2 = $logger->query( [ 'entity_type' => 'review' ], 2, 2 );
		$this->assertCount( 1, $page2['items'] );
	}

	public function test_query_filters_by_date_range(): void {
		global $wpdb;
		$logger = new AuditLogger();
		$logger->record( 'test_old', 'test_entity', 1, null );

		// Backdate the row directly -- record() always stamps "now", and this
		// test needs a row genuinely outside the filtered range to prove the
		// WHERE clause actually excludes it, not just that a fresh row passes.
		$wpdb->update(
			$wpdb->prefix . 'bc_admin_audit_log',
			[ 'created_at' => '2020-01-01 00:00:00' ],
			[ 'action_type' => 'test_old' ]
		);

		$logger->record( 'test_recent', 'test_entity', 2, null );

		$result = $logger->query( [ 'from' => gmdate( 'Y-m-d' ) ], 1, 20 );

		$this->assertSame( 1, $result['total'] );
		$this->assertSame( 'test_recent', $result['items'][0]['action_type'] );
	}
}
