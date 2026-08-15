<?php
declare( strict_types=1 );

namespace BeauClick\Campaigns\Tests;

use BeauClick\Campaigns\CampaignService;
use WP_UnitTestCase;

final class CampaignServiceTest extends WP_UnitTestCase {

	private function valid_fields( array $overrides = [] ): array {
		return array_merge(
			[
				'name'          => 'تخفیف تابستانه',
				'discountType'  => CampaignService::TYPE_PERCENTAGE,
				'discountValue' => 20,
			],
			$overrides
		);
	}

	// 1. A valid campaign is created as a draft.
	public function test_create_makes_a_draft_campaign(): void {
		$service = new CampaignService();
		$result  = $service->create( $this->valid_fields() );

		$this->assertIsArray( $result );
		$campaign = $service->find( $result['id'] );
		$this->assertSame( CampaignService::STATUS_DRAFT, $campaign['status'] );
		$this->assertSame( 'تخفیف تابستانه', $campaign['name'] );
		$this->assertSame( 20, $campaign['discountValue'] );
	}

	// 2. Validation: empty name rejected.
	public function test_create_rejects_an_empty_name(): void {
		$result = ( new CampaignService() )->create( $this->valid_fields( [ 'name' => '  ' ] ) );
		$this->assertIsString( $result );
	}

	// 3. Validation: percentage out of 1-100 range rejected.
	public function test_create_rejects_an_out_of_range_percentage(): void {
		$service = new CampaignService();
		$this->assertIsString( $service->create( $this->valid_fields( [ 'discountValue' => 0 ] ) ) );
		$this->assertIsString( $service->create( $this->valid_fields( [ 'discountValue' => 101 ] ) ) );
	}

	// 4. Validation: fixed discount must be positive.
	public function test_create_rejects_a_non_positive_fixed_discount(): void {
		$result = ( new CampaignService() )->create( $this->valid_fields( [ 'discountType' => CampaignService::TYPE_FIXED, 'discountValue' => 0 ] ) );
		$this->assertIsString( $result );
	}

	// 5. Validation: end date before start date rejected.
	public function test_create_rejects_an_end_date_before_the_start_date(): void {
		$result = ( new CampaignService() )->create(
			$this->valid_fields( [ 'startsAt' => '2026-09-10 00:00:00', 'endsAt' => '2026-09-01 00:00:00' ] )
		);
		$this->assertIsString( $result );
	}

	// 6. Lifecycle: draft -> active -> paused -> active -> archived, each a real, server-enforced transition.
	public function test_full_lifecycle_transitions_succeed_in_order(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$this->assertTrue( $service->activate( $id ) );
		$this->assertSame( CampaignService::STATUS_ACTIVE, $service->find( $id )['status'] );

		$this->assertTrue( $service->pause( $id ) );
		$this->assertSame( CampaignService::STATUS_PAUSED, $service->find( $id )['status'] );

		$this->assertTrue( $service->activate( $id ) );
		$this->assertSame( CampaignService::STATUS_ACTIVE, $service->find( $id )['status'] );

		$this->assertTrue( $service->archive( $id ) );
		$this->assertSame( CampaignService::STATUS_ARCHIVED, $service->find( $id )['status'] );
	}

	// 7. Archived is terminal -- can never be reactivated.
	public function test_an_archived_campaign_cannot_be_reactivated(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];
		$service->archive( $id );

		$result = $service->activate( $id );
		$this->assertIsString( $result );
		$this->assertSame( CampaignService::STATUS_ARCHIVED, $service->find( $id )['status'] );
	}

	// 8. An invalid transition (draft -> paused, skipping active) is rejected.
	public function test_pause_is_rejected_from_draft(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$result = $service->pause( $id );
		$this->assertIsString( $result );
		$this->assertSame( CampaignService::STATUS_DRAFT, $service->find( $id )['status'] );
	}

	// 9. An archived campaign cannot be edited.
	public function test_an_archived_campaign_cannot_be_updated(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];
		$service->archive( $id );

		$result = $service->update( $id, $this->valid_fields( [ 'name' => 'نام جدید' ] ) );
		$this->assertIsString( $result );
	}

	// 10. record_usage() is idempotent per booking -- the UNIQUE(booking_id) constraint, not just application logic.
	public function test_record_usage_is_idempotent_per_booking(): void {
		global $wpdb;
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$first  = $service->record_usage( $id, 101, 501, 9, 5000 );
		$second = $service->record_usage( $id, 101, 502, 9, 5000 ); // Same booking_id, different order_id -- must still be rejected.

		$this->assertTrue( $first );
		$this->assertFalse( $second );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d", $id ) );
		$this->assertSame( 1, $count );
	}

	// 11. usage_count() only counts live ('applied') usage, and release_usage_for_order() moves a row out of that count without deleting it.
	public function test_release_usage_for_order_excludes_it_from_usage_count_without_deleting_the_row(): void {
		global $wpdb;
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$service->record_usage( $id, 201, 601, 9, 5000 );
		$this->assertSame( 1, $service->usage_count( $id ) );

		$service->release_usage_for_order( 601 );
		$this->assertSame( 0, $service->usage_count( $id ), 'A released order must no longer count against the campaign usage cap.' );

		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}bc_campaign_usages WHERE campaign_id = %d", $id ) );
		$this->assertSame( 1, $count, 'The usage row itself must be preserved (an audit record), only its status changes.' );
	}

	// 12. usage_count() scoped to one customer only counts that customer's usage.
	public function test_usage_count_can_be_scoped_to_one_customer(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$service->record_usage( $id, 301, 701, 11, 1000 );
		$service->record_usage( $id, 302, 702, 12, 1000 );

		$this->assertSame( 1, $service->usage_count( $id, 11 ) );
		$this->assertSame( 2, $service->usage_count( $id ) );
	}

	// 13. usage_summary() reports real, live-only aggregates.
	public function test_usage_summary_reports_live_count_and_total_discount(): void {
		$service = new CampaignService();
		$id      = $service->create( $this->valid_fields() )['id'];

		$service->record_usage( $id, 401, 801, 21, 10000 );
		$service->record_usage( $id, 402, 802, 22, 20000 );
		$service->release_usage_for_order( 802 );

		$summary = $service->usage_summary( $id );
		$this->assertSame( 1, $summary['count'] );
		$this->assertSame( 10000, $summary['totalDiscount'] );
	}

	// 14. active_candidates() only returns campaigns whose status is active and whose date window includes $at.
	public function test_active_candidates_filters_by_status_and_date_window(): void {
		$service = new CampaignService();

		$draft = $service->create( $this->valid_fields( [ 'name' => 'پیش‌نویس' ] ) )['id'];

		$active_now = $service->create( $this->valid_fields( [ 'name' => 'فعال اکنون' ] ) )['id'];
		$service->activate( $active_now );

		$future = $service->create( $this->valid_fields( [ 'name' => 'آینده', 'startsAt' => '2099-01-01 00:00:00' ] ) )['id'];
		$service->activate( $future );

		$expired = $service->create( $this->valid_fields( [ 'name' => 'منقضی', 'endsAt' => '2000-01-01 00:00:00' ] ) )['id'];
		$service->activate( $expired );

		$candidates = $service->active_candidates( null, null, '2026-09-01 00:00:00' );
		$ids        = array_column( $candidates, 'id' );

		$this->assertContains( $active_now, $ids );
		$this->assertNotContains( $draft, $ids );
		$this->assertNotContains( $future, $ids );
		$this->assertNotContains( $expired, $ids );
	}

	// 15. active_candidates() targeting: NULL service/provider on the campaign means "any"; a set value must match exactly.
	public function test_active_candidates_respects_service_and_provider_targeting(): void {
		$service = new CampaignService();

		$wildcard = $service->create( $this->valid_fields( [ 'name' => 'همه' ] ) )['id'];
		$service->activate( $wildcard );

		$service_specific = $service->create( $this->valid_fields( [ 'name' => 'خدمت خاص', 'serviceId' => 55 ] ) )['id'];
		$service->activate( $service_specific );

		$now = current_time( 'mysql' );

		$ids_for_service_55 = array_column( $service->active_candidates( 55, null, $now ), 'id' );
		$this->assertContains( $wildcard, $ids_for_service_55 );
		$this->assertContains( $service_specific, $ids_for_service_55 );

		$ids_for_service_99 = array_column( $service->active_candidates( 99, null, $now ), 'id' );
		$this->assertContains( $wildcard, $ids_for_service_99 );
		$this->assertNotContains( $service_specific, $ids_for_service_99, 'A campaign targeting service 55 must never match a booking for service 99.' );
	}
}
