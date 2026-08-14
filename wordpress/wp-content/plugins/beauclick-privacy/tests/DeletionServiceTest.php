<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Tests;

use BeauClick\Auth\Account\AccountEraser;
use BeauClick\Journey\Goals\GoalService;
use BeauClick\Journey\Profile\BeautyProfileService;
use BeauClick\Notifications\Preferences\PreferenceService;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Deletion\DeletionService;
use WP_UnitTestCase;

final class DeletionServiceTest extends WP_UnitTestCase {

	private function make_booking( int $customer_id, string $status ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => 999,
				'slot_id'     => 1,
				'slot_start'  => '2027-01-01 10:00:00',
				'slot_end'    => '2027-01-01 11:00:00',
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return $wpdb->insert_id;
	}

	public function test_blocking_reasons_is_empty_for_a_customer_with_no_commitments(): void {
		$user_id = self::factory()->user->create();
		$this->assertSame( [], ( new DeletionService() )->blocking_reasons( $user_id ) );
	}

	public function test_blocking_reasons_flags_a_pending_booking(): void {
		$user_id = self::factory()->user->create();
		$this->make_booking( $user_id, 'pending' );

		$reasons = ( new DeletionService() )->blocking_reasons( $user_id );
		$this->assertNotEmpty( $reasons );
	}

	public function test_blocking_reasons_does_not_flag_a_completed_or_cancelled_booking(): void {
		$user_id = self::factory()->user->create();
		$this->make_booking( $user_id, 'completed' );
		$this->make_booking( $user_id, 'cancelled' );

		$this->assertSame( [], ( new DeletionService() )->blocking_reasons( $user_id ) );
	}

	public function test_request_deletion_is_blocked_when_a_conflicting_state_exists(): void {
		$user_id = self::factory()->user->create();
		$this->make_booking( $user_id, 'confirmed' );

		$result = ( new DeletionService() )->request_deletion( $user_id );

		$this->assertSame( DataRequestService::STATUS_BLOCKED, $result['status'] );
		$this->assertNotEmpty( $result['reasons'] );
	}

	public function test_request_deletion_succeeds_and_is_idempotent_while_pending(): void {
		$user_id = self::factory()->user->create();
		$service = new DeletionService();

		$first  = $service->request_deletion( $user_id );
		$second = $service->request_deletion( $user_id );

		$this->assertSame( DataRequestService::STATUS_PENDING, $first['status'] );
		$this->assertSame( $first['requestId'], $second['requestId'], 'A second request while one is already pending must return the same request, not create a duplicate.' );
	}

	public function test_cancel_only_works_for_the_owning_user_and_only_while_pending(): void {
		$owner  = self::factory()->user->create();
		$other  = self::factory()->user->create();
		$service = new DeletionService();
		$result  = $service->request_deletion( $owner );

		$this->assertFalse( $service->cancel( $result['requestId'], $other ), 'A different user must never cancel someone else\'s request.' );
		$this->assertTrue( $service->cancel( $result['requestId'], $owner ) );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_CANCELLED, $row['status'] );

		$this->assertFalse( $service->cancel( $result['requestId'], $owner ), 'A cancelled request cannot be cancelled again.' );
	}

	public function test_approve_and_reject_only_transition_a_pending_request(): void {
		$user_id  = self::factory()->user->create();
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$service  = new DeletionService();
		$result   = $service->request_deletion( $user_id );

		$this->assertTrue( $service->approve( $result['requestId'], $admin_id ) );
		$this->assertFalse( $service->reject( $result['requestId'], $admin_id, 'too late' ), 'Cannot reject an already-approved request.' );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_APPROVED, $row['status'] );
		$this->assertSame( $admin_id, (int) $row['reviewed_by'] );
	}

	public function test_process_re_checks_blocking_state_and_does_not_run_if_something_changed(): void {
		$user_id  = self::factory()->user->create();
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$service  = new DeletionService();

		$result = $service->request_deletion( $user_id );
		$service->approve( $result['requestId'], $admin_id );

		// State changes AFTER approval -- a real booking appears before the sweep runs.
		$this->make_booking( $user_id, 'confirmed' );

		$service->process( $result['requestId'] );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_BLOCKED, $row['status'] );
		$this->assertFalse( ( new AccountEraser() )->is_forgotten( $user_id ), 'The account must never be anonymized when the re-check finds a new blocking condition.' );
	}

	public function test_process_erases_every_domain_and_completes(): void {
		$user_id  = self::factory()->user->create( [ 'user_email' => 'to-delete@example.test' ] );
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );

		( new BeautyProfileService() )->update( $user_id, [ 'notes' => 'test note' ] );
		( new GoalService() )->create( $user_id, 'Test goal', null, null, null, null );
		( new PreferenceService() )->update( $user_id, [ PreferenceService::CATEGORY_RETENTION => false ] );

		$service = new DeletionService();
		$result  = $service->request_deletion( $user_id );
		$service->approve( $result['requestId'], $admin_id );
		$service->process( $result['requestId'] );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_COMPLETED, $row['status'] );
		$this->assertNotNull( $row['completed_at'] );

		$this->assertTrue( ( new AccountEraser() )->is_forgotten( $user_id ) );
		$this->assertSame( [], ( new GoalService() )->for_user( $user_id ) );
		$this->assertSame( [ 'userId' => $user_id, 'preferredCityId' => null, 'preferredSpecialtyIds' => [], 'budgetMin' => null, 'budgetMax' => null, 'notes' => null ], ( new BeautyProfileService() )->get( $user_id ) );

		$user = get_userdata( $user_id );
		$this->assertNotFalse( $user, 'get_userdata() must still resolve a real (anonymized) row -- other domains\' retained records depend on this.' );
		$this->assertSame( 'کاربر حذف‌شده', $user->display_name );
	}

	public function test_process_is_idempotent_and_a_repeat_call_on_a_completed_request_is_a_noop(): void {
		$user_id  = self::factory()->user->create();
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );

		$service = new DeletionService();
		$result  = $service->request_deletion( $user_id );
		$service->approve( $result['requestId'], $admin_id );
		$service->process( $result['requestId'] );

		// Re-run against an already-completed request -- process() only acts on 'approved'.
		$service->process( $result['requestId'] );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_COMPLETED, $row['status'] );
	}
}
