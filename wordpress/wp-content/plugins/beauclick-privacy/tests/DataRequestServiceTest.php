<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Tests;

use BeauClick\Privacy\DataRequests\DataRequestService;
use WP_UnitTestCase;

final class DataRequestServiceTest extends WP_UnitTestCase {

	public function test_create_and_find_roundtrip(): void {
		$user_id = self::factory()->user->create();
		$service = new DataRequestService();

		$id = $service->create( $user_id, DataRequestService::TYPE_EXPORT, 'pending' );
		$row = $service->find( $id );

		$this->assertNotNull( $row );
		$this->assertSame( $user_id, (int) $row['user_id'] );
		$this->assertSame( DataRequestService::TYPE_EXPORT, $row['request_type'] );
		$this->assertSame( 'pending', $row['status'] );
	}

	public function test_latest_for_user_filters_by_type_and_status_and_returns_most_recent(): void {
		$user_id = self::factory()->user->create();
		$service = new DataRequestService();

		$first  = $service->create( $user_id, DataRequestService::TYPE_DELETION, DataRequestService::STATUS_REJECTED );
		$second = $service->create( $user_id, DataRequestService::TYPE_DELETION, DataRequestService::STATUS_PENDING );

		$latest = $service->latest_for_user( $user_id, DataRequestService::TYPE_DELETION );
		$this->assertSame( $second, (int) $latest['id'] );

		$rejected_only = $service->latest_for_user( $user_id, DataRequestService::TYPE_DELETION, [ DataRequestService::STATUS_REJECTED ] );
		$this->assertSame( $first, (int) $rejected_only['id'] );
	}

	public function test_latest_for_user_never_returns_another_users_request(): void {
		$user_a = self::factory()->user->create();
		$user_b = self::factory()->user->create();
		$service = new DataRequestService();

		$service->create( $user_a, DataRequestService::TYPE_EXPORT, 'pending' );

		$this->assertNull( $service->latest_for_user( $user_b, DataRequestService::TYPE_EXPORT ) );
	}

	public function test_update_persists_fields(): void {
		$user_id = self::factory()->user->create();
		$service = new DataRequestService();
		$id      = $service->create( $user_id, DataRequestService::TYPE_EXPORT, 'pending' );

		$service->update( $id, [ 'status' => DataRequestService::STATUS_READY, 'export_token' => 'abc123' ] );

		$row = $service->find( $id );
		$this->assertSame( DataRequestService::STATUS_READY, $row['status'] );
		$this->assertSame( 'abc123', $row['export_token'] );
	}

	public function test_batch_with_status_is_bounded(): void {
		$service = new DataRequestService();
		for ( $i = 0; $i < 5; $i++ ) {
			$service->create( self::factory()->user->create(), DataRequestService::TYPE_DELETION, DataRequestService::STATUS_APPROVED );
		}

		$batch = $service->batch_with_status( DataRequestService::TYPE_DELETION, DataRequestService::STATUS_APPROVED, 3 );
		$this->assertCount( 3, $batch );
	}
}
