<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Crm\CrmService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class CrmServiceTest extends WP_UnitTestCase {

	private function make_provider( int $owner_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish', 'post_author' => $owner_id ] );
	}

	private function make_booking( int $provider_id, int $customer_id, string $slot_start, string $status = 'confirmed' ): int {
		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_bookings',
			[
				'customer_id' => $customer_id,
				'provider_id' => $provider_id,
				'slot_id'     => 0,
				'slot_start'  => $slot_start,
				'slot_end'    => $slot_start,
				'status'      => $status,
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);
		return (int) $wpdb->insert_id;
	}

	public function test_customer_list_is_scoped_to_the_current_provider_only(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$provider_b  = $this->make_provider( $owner_b );
		$customer    = self::factory()->user->create();

		$this->make_booking( $provider_a, $customer, gmdate( 'Y-m-d H:i:s', time() - DAY_IN_SECONDS ) );

		$service = new CrmService();
		$result_a = $service->list_customers( $provider_a, '', 'all', 1, 20 );
		$result_b = $service->list_customers( $provider_b, '', 'all', 1, 20 );

		$this->assertCount( 1, $result_a['items'], 'Provider A must see the real customer who booked with them.' );
		$this->assertCount( 0, $result_b['items'], 'Provider B must not see provider A\'s customer.' );
	}

	public function test_booking_counts_and_last_visit_are_correct(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();

		$this->make_booking( $provider_id, $customer_id, gmdate( 'Y-m-d H:i:s', time() - 10 * DAY_IN_SECONDS ), 'completed' );
		$this->make_booking( $provider_id, $customer_id, gmdate( 'Y-m-d H:i:s', time() - 3 * DAY_IN_SECONDS ), 'completed' );

		$items = ( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 20 )['items'];

		$this->assertSame( 2, $items[0]['totalBookings'] );
		$this->assertSame( 2, $items[0]['completedCount'] );
		$this->assertSame( gmdate( 'Y-m-d H:i:s', time() - 3 * DAY_IN_SECONDS ), $items[0]['lastVisit'], 'lastVisit must be the most recent completed booking, not merely the most recent row.' );
	}

	public function test_next_booking_only_counts_a_future_confirmed_slot(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();

		$future = gmdate( 'Y-m-d H:i:s', time() + 5 * DAY_IN_SECONDS );
		$this->make_booking( $provider_id, $customer_id, gmdate( 'Y-m-d H:i:s', time() - 20 * DAY_IN_SECONDS ), 'completed' );
		$this->make_booking( $provider_id, $customer_id, $future, 'confirmed' );

		$items = ( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 20 )['items'];

		$this->assertSame( $future, $items[0]['nextBooking'] );
	}

	public function test_next_booking_is_null_when_only_a_past_or_pending_booking_exists(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();

		$this->make_booking( $provider_id, $customer_id, gmdate( 'Y-m-d H:i:s', time() + 5 * DAY_IN_SECONDS ), 'pending' );

		$items = ( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 20 )['items'];

		$this->assertNull( $items[0]['nextBooking'], 'A merely-pending future booking (never confirmed) must not read as a real upcoming visit.' );
	}

	public function test_search_matches_name_email_and_phone_including_persian_digits(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create( [ 'display_name' => 'مریم رضایی', 'user_email' => 'maryam@example.com' ] );
		update_user_meta( $customer_id, '_billing_phone', '09121234567' );
		$this->make_booking( $provider_id, $customer_id, gmdate( 'Y-m-d H:i:s' ), 'completed' );

		$service = new CrmService();

		$this->assertCount( 1, $service->list_customers( $provider_id, 'رضایی', 'all', 1, 20 )['items'] );
		$this->assertCount( 1, $service->list_customers( $provider_id, 'maryam', 'all', 1, 20 )['items'] );
		$this->assertCount( 1, $service->list_customers( $provider_id, '۰۹۱۲۱۲۳۴۵۶۷', 'all', 1, 20 )['items'], 'Persian-digit phone search must match the ASCII-stored phone number.' );
		$this->assertCount( 0, $service->list_customers( $provider_id, 'کسی‌که‌وجود‌ندارد', 'all', 1, 20 )['items'] );
	}

	public function test_filters_are_derived_correctly(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );

		$returning = self::factory()->user->create();
		$this->make_booking( $provider_id, $returning, gmdate( 'Y-m-d H:i:s', time() - 40 * DAY_IN_SECONDS ), 'completed' );
		$this->make_booking( $provider_id, $returning, gmdate( 'Y-m-d H:i:s', time() - 5 * DAY_IN_SECONDS ), 'completed' );

		$inactive = self::factory()->user->create();
		$this->make_booking( $provider_id, $inactive, gmdate( 'Y-m-d H:i:s', time() - 90 * DAY_IN_SECONDS ), 'completed' );

		$upcoming = self::factory()->user->create();
		$this->make_booking( $provider_id, $upcoming, gmdate( 'Y-m-d H:i:s', time() + 2 * DAY_IN_SECONDS ), 'confirmed' );

		$service = new CrmService();

		$returning_ids = array_column( $service->list_customers( $provider_id, '', 'returning', 1, 20 )['items'], 'customerId' );
		$this->assertSame( [ $returning ], $returning_ids );

		$inactive_ids = array_column( $service->list_customers( $provider_id, '', 'inactive', 1, 20 )['items'], 'customerId' );
		$this->assertSame( [ $inactive ], $inactive_ids );

		$upcoming_ids = array_column( $service->list_customers( $provider_id, '', 'upcoming', 1, 20 )['items'], 'customerId' );
		$this->assertSame( [ $upcoming ], $upcoming_ids );
	}

	public function test_pagination_returns_the_correct_slice_and_total(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );

		for ( $i = 0; $i < 5; $i++ ) {
			$customer = self::factory()->user->create();
			$this->make_booking( $provider_id, $customer, gmdate( 'Y-m-d H:i:s', time() - $i * DAY_IN_SECONDS ), 'completed' );
		}

		$page1 = ( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 2 );
		$page2 = ( new CrmService() )->list_customers( $provider_id, '', 'all', 2, 2 );

		$this->assertSame( 5, $page1['total'] );
		$this->assertCount( 2, $page1['items'] );
		$this->assertCount( 2, $page2['items'] );
		$this->assertNotSame( $page1['items'][0]['customerId'], $page2['items'][0]['customerId'] );
	}

	public function test_empty_customer_list_returns_zero_total_not_an_error(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );

		$result = ( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 20 );

		$this->assertSame( [], $result['items'] );
		$this->assertSame( 0, $result['total'] );
	}

	public function test_is_customer_of_is_the_real_ownership_boundary(): void {
		$owner_a     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$real_customer = self::factory()->user->create();
		$stranger      = self::factory()->user->create();
		$this->make_booking( $provider_a, $real_customer, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$this->assertTrue( $service->is_customer_of( $provider_a, $real_customer ) );
		$this->assertFalse( $service->is_customer_of( $provider_a, $stranger ), 'A user who never booked with this provider must not be treated as their customer.' );
	}

	public function test_customer_detail_is_null_for_a_non_customer(): void {
		$owner      = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$stranger    = self::factory()->user->create();

		$this->assertNull( ( new CrmService() )->get_customer_detail( $provider_id, $stranger ) );
	}

	public function test_customer_detail_includes_bookings_reviews_and_notes(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id, current_time( 'mysql' ), 'completed' );

		global $wpdb;
		$wpdb->insert(
			$wpdb->prefix . 'bc_reviews',
			[
				'author_id'   => $customer_id,
				'target_type' => 'provider',
				'target_id'   => $provider_id,
				'booking_id'  => 999999,
				'rating'      => 5,
				'body'        => 'عالی بود',
				'status'      => 'approved',
				'created_at'  => current_time( 'mysql' ),
				'updated_at'  => current_time( 'mysql' ),
			]
		);

		$service = new CrmService();
		$service->add_note( $provider_id, $customer_id, $owner, 'مشتری همیشگیه، رنگ مو دوست داره.' );

		$detail = $service->get_customer_detail( $provider_id, $customer_id );

		$this->assertCount( 1, $detail['bookings'] );
		$this->assertCount( 1, $detail['reviews'] );
		$this->assertSame( 5, $detail['reviews'][0]['rating'] );
		$this->assertCount( 1, $detail['notes'] );
		$this->assertSame( 'مشتری همیشگیه، رنگ مو دوست داره.', $detail['notes'][0]['note'] );
	}

	public function test_a_note_can_only_be_added_for_a_genuine_customer(): void {
		$owner      = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$stranger    = self::factory()->user->create();

		$note = ( new CrmService() )->add_note( $provider_id, $stranger, $owner, 'یادداشت نامعتبر' );

		$this->assertNull( $note, 'A note must never be attachable to a user who is not genuinely this provider\'s customer.' );
	}

	public function test_notes_do_not_leak_across_unrelated_providers(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$provider_b  = $this->make_provider( $owner_b );
		$customer    = self::factory()->user->create();
		$this->make_booking( $provider_a, $customer, current_time( 'mysql' ), 'completed' );
		$this->make_booking( $provider_b, $customer, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$service->add_note( $provider_a, $customer, $owner_a, 'یادداشت متخصص الف' );

		$notes_a = $service->list_notes( $provider_a, $customer );
		$notes_b = $service->list_notes( $provider_b, $customer );

		$this->assertCount( 1, $notes_a );
		$this->assertCount( 0, $notes_b, 'The same shared customer\'s notes from provider A must never be visible to provider B.' );
	}

	public function test_an_empty_or_whitespace_note_is_rejected(): void {
		$owner      = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id, current_time( 'mysql' ), 'completed' );

		$this->assertNull( ( new CrmService() )->add_note( $provider_id, $customer_id, $owner, '   ' ) );
	}

	public function test_customer_list_avoids_n_plus_one_queries(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		for ( $i = 0; $i < 8; $i++ ) {
			$customer = self::factory()->user->create();
			$this->make_booking( $provider_id, $customer, gmdate( 'Y-m-d H:i:s', time() - $i * DAY_IN_SECONDS ), 'completed' );
		}

		global $wpdb;
		$before = $wpdb->num_queries;
		( new CrmService() )->list_customers( $provider_id, '', 'all', 1, 20 );
		$query_count = $wpdb->num_queries - $before;

		// A fixed, small number of bulk queries (bookings aggregate, users,
		// phones, reviews, notes) regardless of customer count — never one
		// query per customer. 8 customers, well under a naive 8x N+1 count.
		$this->assertLessThan( 10, $query_count, "Customer list must not issue a query per customer (got {$query_count} queries for 8 customers)." );
	}

	// --- V2.2 Step 16 -- note edit/delete ---------------------------------

	public function test_the_author_can_edit_their_own_note(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$note    = $service->add_note( $provider_id, $customer_id, $owner, 'یادداشت اولیه' );
		$updated = $service->update_note( $provider_id, $customer_id, $note['id'], $owner, 'یادداشت ویرایش‌شده' );

		$this->assertNotNull( $updated );
		$this->assertSame( 'یادداشت ویرایش‌شده', $updated['note'] );
	}

	public function test_a_different_user_cannot_edit_someone_elses_note(): void {
		$owner        = self::factory()->user->create();
		$other_writer = self::factory()->user->create();
		$provider_id  = $this->make_provider( $owner );
		$customer_id  = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$note    = $service->add_note( $provider_id, $customer_id, $owner, 'یادداشت اصلی' );
		$result  = $service->update_note( $provider_id, $customer_id, $note['id'], $other_writer, 'تلاش برای ویرایش' );

		$this->assertNull( $result, 'Only the note\'s own author may edit it, even another staff member of the same business.' );
	}

	public function test_the_author_can_delete_their_own_note(): void {
		$owner       = self::factory()->user->create();
		$provider_id = $this->make_provider( $owner );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_id, $customer_id, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$note    = $service->add_note( $provider_id, $customer_id, $owner, 'یادداشت موقت' );
		$deleted = $service->delete_note( $provider_id, $customer_id, $note['id'], $owner );

		$this->assertTrue( $deleted );
		$this->assertCount( 0, $service->list_notes( $provider_id, $customer_id ) );
	}

	public function test_deleting_a_note_for_a_customer_that_is_not_really_yours_fails(): void {
		$owner_a     = self::factory()->user->create();
		$owner_b     = self::factory()->user->create();
		$provider_a  = $this->make_provider( $owner_a );
		$provider_b  = $this->make_provider( $owner_b );
		$customer_id = self::factory()->user->create();
		$this->make_booking( $provider_a, $customer_id, current_time( 'mysql' ), 'completed' );

		$service = new CrmService();
		$note    = $service->add_note( $provider_a, $customer_id, $owner_a, 'یادداشت واقعی' );

		// provider_b never had this customer -- is_customer_of() must fail first.
		$deleted = $service->delete_note( $provider_b, $customer_id, $note['id'], $owner_a );

		$this->assertFalse( $deleted );
	}
}
