<?php
declare( strict_types=1 );

namespace BeauClick\Booking\Tests;

use BeauClick\Booking\Waitlist\WaitlistService;
use BeauClick\Marketplace\PostTypes\Registrar;
use WP_UnitTestCase;

final class WaitlistServiceTest extends WP_UnitTestCase {

	private function make_provider(): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'publish' ] );
	}

	private function make_service( int $provider_id ): int {
		return self::factory()->post->create( [ 'post_type' => Registrar::SERVICE, 'post_status' => 'publish', 'post_parent' => $provider_id ] );
	}

	// 1. create waitlist.
	public function test_a_customer_can_join_the_waitlist_for_a_real_provider(): void {
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();

		$result = ( new WaitlistService() )->create( $customer_id, $provider_id, null, null, null, null );

		$this->assertIsArray( $result );
		$entry = ( new WaitlistService() )->find( $result['id'] );
		$this->assertSame( 'waiting', $entry['status'] );
	}

	// §5: scoped to real bookable data only.
	public function test_joining_the_waitlist_for_a_nonexistent_provider_is_rejected(): void {
		$result = ( new WaitlistService() )->create( self::factory()->user->create(), 999999, null, null, null, null );
		$this->assertIsString( $result );
	}

	public function test_joining_the_waitlist_for_an_unpublished_provider_is_rejected(): void {
		$provider_id = self::factory()->post->create( [ 'post_type' => Registrar::PROFESSIONAL, 'post_status' => 'draft' ] );
		$result       = ( new WaitlistService() )->create( self::factory()->user->create(), $provider_id, null, null, null, null );
		$this->assertIsString( $result );
	}

	public function test_joining_the_waitlist_with_a_service_that_does_not_belong_to_the_provider_is_rejected(): void {
		$provider_a = $this->make_provider();
		$provider_b = $this->make_provider();
		$service_of_b = $this->make_service( $provider_b );

		$result = ( new WaitlistService() )->create( self::factory()->user->create(), $provider_a, $service_of_b, null, null, null );

		$this->assertIsString( $result );
	}

	public function test_joining_the_waitlist_with_a_past_preferred_date_is_rejected(): void {
		$provider_id = $this->make_provider();
		$result       = ( new WaitlistService() )->create( self::factory()->user->create(), $provider_id, null, '2020-01-01', null, null );
		$this->assertIsString( $result );
	}

	// 2. list own.
	public function test_a_customer_sees_only_their_own_waitlist_entries(): void {
		$provider_id = $this->make_provider();
		$customer_a  = self::factory()->user->create();
		$customer_b  = self::factory()->user->create();
		$service     = new WaitlistService();
		$service->create( $customer_a, $provider_id, null, null, null, null );
		$service->create( $customer_b, $provider_id, null, null, null, null );

		$entries = $service->for_user( $customer_a );

		$this->assertCount( 1, $entries );
		$this->assertSame( $customer_a, $entries[0]['customerId'] );
	}

	// 3. cancel own.
	public function test_cancelling_a_waiting_entry_succeeds(): void {
		$provider_id = $this->make_provider();
		$service     = new WaitlistService();
		$result      = $service->create( self::factory()->user->create(), $provider_id, null, null, null, null );

		$ok = $service->cancel( $result['id'] );

		$this->assertTrue( $ok );
		$this->assertSame( 'cancelled', $service->find( $result['id'] )['status'] );
	}

	public function test_cancelling_an_already_cancelled_entry_is_a_no_op_failure(): void {
		$provider_id = $this->make_provider();
		$service     = new WaitlistService();
		$result      = $service->create( self::factory()->user->create(), $provider_id, null, null, null, null );
		$service->cancel( $result['id'] );

		$this->assertFalse( $service->cancel( $result['id'] ), 'Cancelling an already-cancelled entry must not succeed a second time.' );
	}

	// 7. duplicate waitlist prevention.
	public function test_joining_the_same_provider_service_date_combination_twice_is_rejected(): void {
		$provider_id = $this->make_provider();
		$service_id  = $this->make_service( $provider_id );
		$customer_id = self::factory()->user->create();
		$waitlist    = new WaitlistService();

		$waitlist->create( $customer_id, $provider_id, $service_id, '2027-01-01', null, null );
		$result = $waitlist->create( $customer_id, $provider_id, $service_id, '2027-01-01', null, null );

		$this->assertIsString( $result );
	}

	public function test_a_different_preferred_date_is_not_treated_as_a_duplicate(): void {
		$provider_id = $this->make_provider();
		$customer_id = self::factory()->user->create();
		$waitlist    = new WaitlistService();

		$first  = $waitlist->create( $customer_id, $provider_id, null, '2027-01-01', null, null );
		$second = $waitlist->create( $customer_id, $provider_id, null, '2027-01-02', null, null );

		$this->assertIsArray( $first );
		$this->assertIsArray( $second, 'A different preferred date must not collide with a different existing entry.' );
	}

	// 6. expiration.
	public function test_expire_due_marks_a_past_expiry_entry_as_expired(): void {
		global $wpdb;
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$result      = $waitlist->create( self::factory()->user->create(), $provider_id, null, null, null, null );
		$wpdb->update( $wpdb->prefix . 'bc_waitlist_entries', [ 'expires_at' => '2020-01-01 00:00:00' ], [ 'id' => $result['id'] ] );

		$count = $waitlist->expire_due();

		$this->assertSame( 1, $count );
		$this->assertSame( 'expired', $waitlist->find( $result['id'] )['status'] );
	}

	public function test_expire_due_never_touches_an_entry_not_yet_due(): void {
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$result      = $waitlist->create( self::factory()->user->create(), $provider_id, null, null, null, null );

		$waitlist->expire_due();

		$this->assertSame( 'waiting', $waitlist->find( $result['id'] )['status'] );
	}

	// 5. matching.
	public function test_matching_finds_entries_for_the_same_provider_and_date(): void {
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$entry       = $waitlist->create( self::factory()->user->create(), $provider_id, null, '2027-03-01', null, null );

		$matches = $waitlist->matching( $provider_id, null, '2027-03-01' );

		$this->assertCount( 1, $matches );
		$this->assertSame( $entry['id'], $matches[0]['id'] );
	}

	public function test_matching_excludes_entries_for_a_different_provider(): void {
		$provider_a = $this->make_provider();
		$provider_b = $this->make_provider();
		$waitlist   = new WaitlistService();
		$waitlist->create( self::factory()->user->create(), $provider_a, null, null, null, null );

		$matches = $waitlist->matching( $provider_b, null, '2027-03-01' );

		$this->assertCount( 0, $matches );
	}

	public function test_matching_excludes_entries_requiring_a_different_specific_date(): void {
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$waitlist->create( self::factory()->user->create(), $provider_id, null, '2027-03-05', null, null );

		$matches = $waitlist->matching( $provider_id, null, '2027-03-01' );

		$this->assertCount( 0, $matches, 'An entry that only wants a specific date must not match a different date.' );
	}

	public function test_matching_includes_an_entry_with_no_date_preference_for_any_date(): void {
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$waitlist->create( self::factory()->user->create(), $provider_id, null, null, null, null );

		$matches = $waitlist->matching( $provider_id, null, '2027-03-01' );

		$this->assertCount( 1, $matches, 'An entry with no specific date preference should match any opening for that provider.' );
	}

	public function test_matching_is_ordered_fifo_by_creation_time(): void {
		$provider_id = $this->make_provider();
		$waitlist    = new WaitlistService();
		$first  = $waitlist->create( self::factory()->user->create(), $provider_id, null, null, null, null );
		$second = $waitlist->create( self::factory()->user->create(), $provider_id, null, null, null, null );

		$matches = $waitlist->matching( $provider_id, null, '2027-03-01' );

		$this->assertSame( $first['id'], $matches[0]['id'] );
		$this->assertSame( $second['id'], $matches[1]['id'] );
	}
}
