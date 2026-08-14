<?php
declare( strict_types=1 );

namespace BeauClick\Privacy\Tests;

use BeauClick\Privacy\Admin\PrivacyRequestsPage;
use BeauClick\Privacy\DataRequests\DataRequestService;
use BeauClick\Privacy\Deletion\DeletionService;
use WP_UnitTestCase;

final class PrivacyRequestsPageTest extends WP_UnitTestCase {

	public function test_registers_a_submenu_under_the_beauclick_parent(): void {
		global $submenu;

		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $admin_id );

		( new PrivacyRequestsPage() )->add_page();

		$slugs = array_column( $submenu['beauclick'] ?? [], 2 );
		$this->assertContains( 'beauclick-privacy-requests', $slugs );
	}

	public function test_render_denies_a_user_without_bc_manage_platform(): void {
		$customer_id = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		wp_set_current_user( $customer_id );

		$this->expectException( \WPDieException::class );
		( new PrivacyRequestsPage() )->render();
	}

	public function test_handle_approve_writes_an_audit_log_entry(): void {
		global $wpdb;
		$user_id  = self::factory()->user->create();
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );

		$result = ( new DeletionService() )->request_deletion( $user_id );
		$approved = ( new DeletionService() )->approve( $result['requestId'], $admin_id );

		$this->assertTrue( $approved );
		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'privacy_deletion_approved' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$this->assertSame( $user_id, (int) $row['entity_id'] );
		$this->assertSame( $admin_id, (int) $row['actor_user_id'] );
	}

	public function test_reject_requires_a_reason_and_records_it(): void {
		$user_id  = self::factory()->user->create();
		$admin_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		$result   = ( new DeletionService() )->request_deletion( $user_id );

		$service = new DeletionService();
		$this->assertTrue( $service->reject( $result['requestId'], $admin_id, 'حساب مشکوک به سوءاستفاده است' ) );

		$row = ( new DataRequestService() )->find( $result['requestId'] );
		$this->assertSame( DataRequestService::STATUS_REJECTED, $row['status'] );
		$this->assertSame( 'حساب مشکوک به سوءاستفاده است', $row['reason'] );
	}
}
