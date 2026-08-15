<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Tests;

use BeauClick\Campaigns\Admin\CampaignAdminPage;
use BeauClick\Campaigns\CampaignService;
use WP_UnitTestCase;

/**
 * Every campaign lifecycle action taken through this admin page must write
 * to the general admin audit log — mirrors beauclick-loyalty's own
 * `LoyaltyAdminPageTest` exactly: each "*_and_log()" method is tested
 * directly, never the admin-post.php handle_*() wrappers (which end in
 * wp_safe_redirect()+exit and cannot run inside a test process).
 */
final class CampaignAdminPageTest extends WP_UnitTestCase {

	private function as_operator(): int {
		$operator_id = self::factory()->user->create( [ 'role' => 'administrator' ] );
		wp_set_current_user( $operator_id );
		return $operator_id;
	}

	private function valid_fields(): array {
		return [ 'name' => 'کمپین پاییزه', 'discountType' => CampaignService::TYPE_PERCENTAGE, 'discountValue' => 25 ];
	}

	// 1. Creating a campaign records an audit entry with the real actor.
	public function test_create_campaign_and_log_records_an_audit_entry(): void {
		global $wpdb;
		$operator_id = $this->as_operator();

		$id = ( new CampaignAdminPage() )->create_campaign_and_log( $this->valid_fields() );
		$this->assertIsInt( $id );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertSame( 'campaign_created', $row['action_type'] );
		$this->assertSame( 'campaign', $row['entity_type'] );
		$this->assertSame( $id, (int) $row['entity_id'] );
		$this->assertSame( $operator_id, (int) $row['actor_user_id'] );
	}

	// 2. A validation failure logs nothing.
	public function test_create_campaign_and_log_does_not_record_an_audit_entry_on_validation_failure(): void {
		global $wpdb;
		$this->as_operator();

		$result = ( new CampaignAdminPage() )->create_campaign_and_log( [ 'name' => '', 'discountType' => CampaignService::TYPE_PERCENTAGE, 'discountValue' => 10 ] );

		$this->assertIsString( $result );
		$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );
		$this->assertSame( 0, $count );
	}

	// 3. Updating a campaign records previous/new state.
	public function test_update_campaign_and_log_records_previous_and_new_state(): void {
		global $wpdb;
		$page = new CampaignAdminPage();
		$this->as_operator();
		$id = $page->create_campaign_and_log( $this->valid_fields() );

		$page->update_campaign_and_log( $id, array_merge( $this->valid_fields(), [ 'name' => 'کمپین به‌روزشده' ] ) );

		$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}bc_admin_audit_log WHERE action_type = 'campaign_updated' ORDER BY id DESC LIMIT 1", ARRAY_A );
		$this->assertNotNull( $row );
		$this->assertSame( 'کمپین پاییزه', json_decode( $row['previous_state'], true )['name'] );
		$this->assertSame( 'کمپین به‌روزشده', json_decode( $row['new_state'], true )['name'] );
	}

	// 4. Full lifecycle (activate/pause/archive) each records its own audit entry with a real status transition.
	public function test_activate_pause_archive_each_record_an_audit_entry(): void {
		global $wpdb;
		$page = new CampaignAdminPage();
		$this->as_operator();
		$id = $page->create_campaign_and_log( $this->valid_fields() );

		$this->assertTrue( $page->activate_and_log( $id ) );
		$this->assertTrue( $page->pause_and_log( $id ) );
		$this->assertTrue( $page->activate_and_log( $id ) );
		$this->assertTrue( $page->archive_and_log( $id ) );

		$actions = $wpdb->get_col( $wpdb->prepare( "SELECT action_type FROM {$wpdb->prefix}bc_admin_audit_log WHERE entity_type = 'campaign' AND entity_id = %d ORDER BY id ASC", $id ) );
		$this->assertSame( [ 'campaign_created', 'campaign_activated', 'campaign_paused', 'campaign_activated', 'campaign_archived' ], $actions );
	}

	// 5. An invalid transition returns an error and logs nothing new.
	public function test_an_invalid_transition_logs_nothing(): void {
		global $wpdb;
		$page = new CampaignAdminPage();
		$this->as_operator();
		$id = $page->create_campaign_and_log( $this->valid_fields() );

		$before_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );
		$result       = $page->pause_and_log( $id ); // Draft -> paused is not a valid transition.
		$after_count  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_admin_audit_log" );

		$this->assertIsString( $result );
		$this->assertSame( $before_count, $after_count );
	}
}
